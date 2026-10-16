import ActivityKit
import AVFoundation
import AVKit
import ExpoModulesCore
import Network
import ObjectiveC
import UIKit
import WebRTC

// kDNSServiceErr_PolicyDenied: the user has not allowed Local Network access.
private let dnsPolicyDenied: Int32 = -65570

// Longest message a peer may send (an SDP offer is ~10 KB). Anyone on the network can connect
// before pairing, so a peer that streams bytes without a newline is cut off instead of
// growing the buffer until iOS kills the app.
private let maxMessageBytes = 256 * 1024

// Most incoming connections open at once. The JS side keeps at most 8 unauthenticated ones and every
// paired parent needs one; this cap holds before any of that, so a flood of connections can't use up
// memory (each may buffer up to maxMessageBytes) faster than JS closes them.
private let maxIncomingPeers = 32

/// One TCP connection carrying newline-delimited UTF-8 messages.
private final class Peer {
  let id = UUID().uuidString
  let connection: NWConnection
  let incoming: Bool
  var buffer = Data()
  var closed = false

  init(connection: NWConnection, incoming: Bool) {
    self.connection = connection
    self.incoming = incoming
  }
}

public class BabyNativeModule: Module {
  // All network state is touched only on this queue.
  private let queue = DispatchQueue(label: "baby-native.network")
  /// Bonjour type; development builds use their own, so they never find real baby units.
  private var serviceType = "_babymon._tcp"
  private var listener: NWListener?
  private var browser: NWBrowser?
  private var peers: [String: Peer] = [:]

  public func definition() -> ModuleDefinition {
    Name("BabyNative")

    Events(
      "onServerState", "onBrowserState", "onServicesChanged", "onPeerOpen", "onPeerMessage", "onPeerClose",
      "onMotion", "onLoudSound", "onCry", "onPlayoutLevel", "onBatteryChange")

    OnCreate {
      MotionDetector.shared.onMotion = { [weak self] level in
        self?.sendEvent("onMotion", ["level": level])
      }
      MotionDetector.register()
      NightVision.register()
      BabyAudioDevice.shared.onLoudSound = { [weak self] in
        self?.sendEvent("onLoudSound", [:])
      }
      BabyAudioDevice.shared.onPlayoutLevel = { [weak self] level in
        self?.sendEvent("onPlayoutLevel", ["level": level])
      }
      CryDetector.shared.onCry = { [weak self] in
        self?.sendEvent("onCry", [:])
      }
    }

    OnDestroy {
      self.queue.sync {
        self.listener?.cancel()
        self.browser?.cancel()
        self.peers.values.forEach { $0.connection.cancel() }
        self.peers.removeAll()
      }
    }


    // Hides the home indicator and makes edge swipes need a second swipe,
    // so the monitor screen stays fully black and harder to leave by accident.
    // react-native-webrtc's own startIOSPIP goes through legacy view commands, which may not
    // reach the view under the new architecture; drive its PiP controller directly instead.
    // Resolves with what happened, so the app can explain a refusal.
    AsyncFunction("togglePictureInPicture") { () -> String in
      guard let video = Self.videoViews().first else { return "no-video" }
      // RTCVideoView.pipController (react-native-webrtc's PIPController) → its AVPictureInPictureController.
      guard let wrapper = video.value(forKey: "pipController") as? NSObject else { return "no-controller" }
      guard let pip = wrapper.value(forKey: "pipController") as? AVPictureInPictureController else { return "no-av-controller" }
      if pip.isPictureInPictureActive {
        pip.stopPictureInPicture()
        return "stopped"
      }
      guard AVPictureInPictureController.isPictureInPictureSupported() else { return "unsupported" }
      guard pip.isPictureInPicturePossible else { return "not-possible" }
      NSLog("[BabyNative] starting PiP, window size %@", NSCoder.string(for: (wrapper.value(forKey: "preferredSize") as? NSValue)?.cgSizeValue ?? .zero))
      pip.startPictureInPicture()
      return "started"
    }.runOnQueue(.main)

    // Whether leaving the app may turn the video into Picture in Picture. For a video call iOS
    // starts PiP on its own even with canStartPictureInPictureAutomaticallyFromInline off, so
    // "off" drops react-native-webrtc's PiP controller altogether (the iosPIP prop recreates it).
    Function("setAutoPictureInPicture") { (enabled: Bool) in
      DispatchQueue.main.async {
        let views = Self.videoViews()
        for video in views {
          guard let pip = (video.value(forKey: "pipController") as? NSObject)?
            .value(forKey: "pipController") as? AVPictureInPictureController else { continue }
          pip.canStartPictureInPictureAutomaticallyFromInline = enabled
          if !enabled && !pip.isPictureInPictureActive {
            video.setValue(nil, forKey: "pipController")
          }
        }
        NSLog("[BabyNative] automatic PiP %@ for %d video view(s)", enabled ? "on" : "off", views.count)
      }
    }

    Function("setImmersive") { (enabled: Bool) in
      DispatchQueue.main.async {
        ImmersiveMode.set(enabled)
      }
    }

    /// Cryptographically random decimal digits, for pairing codes and the baby unit's id.
    Function("randomDigits") { (count: Int) -> String in
      var generator = SystemRandomNumberGenerator()
      return String((0..<count).map { _ in Character(String(Int.random(in: 0...9, using: &generator))) })
    }

    /// Sleep sound on the baby unit's speaker (see SleepSynth.Kind), mixed so that the
    /// microphone's echo canceller removes it again.
    Function("playSleepSound") { (kind: String, volume: Double) in
      BabyAudioDevice.shared.startSleepSound(kind: kind, volume: volume)
    }

    Function("setSleepSoundVolume") { (volume: Double) in
      BabyAudioDevice.shared.setSleepSoundVolume(volume)
    }

    Function("stopSleepSound") {
      BabyAudioDevice.shared.stopSleepSound()
    }

    /// Classifier confidence (0...1) that counts as a baby crying; 0 turns crying detection off.
    Function("setCryThreshold") { (confidence: Double) in
      CryDetector.shared.threshold = confidence
    }

    /// This device's battery: level 0...1 (-1 if unknown) and whether it's charging.
    /// Also starts onBatteryChange events.
    Function("getBattery") { () -> [String: Any] in
      DispatchQueue.main.async { self.observeBattery() }
      return Self.battery()
    }

    /// Whether this device shows Live Activities (iPhone with iOS 16.2+ and the user allows them; not iPad).
    Function("areLiveActivitiesEnabled") { () -> Bool in
      if #available(iOS 16.2, *) { return ActivityAuthorizationInfo().areActivitiesEnabled }
      return false
    }

    // Parent lock screen / Dynamic Island status (iOS 16.2+; ignored elsewhere).
    Function("updateLiveActivity") { (monitorName: String, state: LiveActivityState) in
      DispatchQueue.main.async {
        if #available(iOS 16.2, *) { LiveActivityController.update(monitorName: monitorName, state: state) }
      }
    }

    Function("endLiveActivity") {
      DispatchQueue.main.async {
        if #available(iOS 16.2, *) { LiveActivityController.end() }
      }
    }

    /// How many dB above the room's usual noise a sound must rise to be reported; 0 turns it off.
    Function("setLoudSoundThreshold") { (decibels: Double) in
      BabyAudioDevice.shared.loudThreshold = Float(decibels)
    }

    /// 'off' | 'auto' | 'on': brighten the camera picture (and expose longer) in a dark room.
    Function("setNightMode") { (mode: String) in
      NightVision.shared.filter.mode = NightFilter.Mode(rawValue: mode) ?? .auto
    }

    /// Fraction of the picture that must change to count as motion; 0 turns detection off.
    Function("setMotionThreshold") { (threshold: Double) in
      MotionDetector.shared.threshold = threshold
    }

    Function("setServiceType") { (type: String) in
      self.queue.async { self.serviceType = type }
    }

    // A fixed port keeps working even when a parent still has an old Bonjour record cached,
    // and lets parents on another subnet connect straight to the IP address.
    Function("startServer") { (name: String, port: Int) in
      self.queue.async { self.startServerOnQueue(name: name, port: port) }
    }

    Function("stopServer") {
      self.queue.async {
        self.listener?.cancel()
        self.listener = nil
        self.peers.values.filter { $0.incoming }.forEach { self.close($0) }
      }
    }

    Function("startBrowsing") {
      self.queue.async { self.startBrowsingOnQueue() }
    }

    Function("stopBrowsing") {
      self.queue.async {
        self.browser?.cancel()
        self.browser = nil
      }
    }

    Function("connect") { (serviceName: String) -> String in
      self.connect(to: .service(name: serviceName, type: self.serviceType, domain: "local.", interface: nil))
    }

    Function("connectAddress") { (host: String, port: Int) -> String in
      self.connect(to: .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(integerLiteral: UInt16(port))))
    }

    /// IPv4 addresses of this device on Wi-Fi / Ethernet, for connecting without Bonjour.
    Function("getLocalAddresses") { () -> [String] in
      Self.localIPv4Addresses()
    }

    // Finds monitors when Bonjour can't: some access points drop the multicast it relies on,
    // but plain TCP to each address of the subnet still gets through.
    AsyncFunction("scanSubnet") { (port: Int, promise: Promise) in
      Self.scanSubnet(port: UInt16(port), promise: promise)
    }

    Function("send") { (peerId: String, message: String) in
      self.queue.async {
        guard let peer = self.peers[peerId], !peer.closed else { return }
        var data = Data(message.utf8)
        data.append(0x0A)
        peer.connection.send(content: data, completion: .contentProcessed { [weak self] error in
          if error != nil { self?.close(peer) }
        })
      }
    }

    Function("closePeer") { (peerId: String) in
      self.queue.async {
        if let peer = self.peers[peerId] { self.close(peer) }
      }
    }
  }

  // MARK: - Server (monitor side)

  private func startServerOnQueue(name: String, port: Int) {
    listener?.cancel()
    do {
      let listener = try NWListener(using: Self.parameters(), on: NWEndpoint.Port(integerLiteral: UInt16(port)))
      listener.service = NWListener.Service(name: name, type: serviceType)
      listener.stateUpdateHandler = { [weak self] state in
        self?.sendEvent("onServerState", Self.statePayload(state))
      }
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else {
          connection.cancel()
          return
        }
        if self.peers.values.filter({ $0.incoming }).count >= maxIncomingPeers {
          connection.cancel()
          return
        }
        self.start(Peer(connection: connection, incoming: true))
      }
      listener.start(queue: queue)
      self.listener = listener
    } catch {
      sendEvent("onServerState", ["state": "failed", "error": error.localizedDescription, "denied": false])
    }
  }

  // MARK: - Browser (parent side)

  private func startBrowsingOnQueue() {
    browser?.cancel()
    let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: Self.parameters())
    browser.stateUpdateHandler = { [weak self] state in
      self?.sendEvent("onBrowserState", Self.statePayload(state))
    }
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      var names = Set<String>()
      for result in results {
        if case let .service(name, _, _, _) = result.endpoint { names.insert(name) }
      }
      self?.sendEvent("onServicesChanged", ["services": names.sorted()])
    }
    browser.start(queue: queue)
    self.browser = browser
  }

  // MARK: - Connections

  private func connect(to endpoint: NWEndpoint) -> String {
    let peer = Peer(connection: NWConnection(to: endpoint, using: Self.parameters()), incoming: false)
    queue.async { self.start(peer) }
    return peer.id
  }

  private func start(_ peer: Peer) {
    peers[peer.id] = peer
    peer.connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.sendEvent("onPeerOpen", ["peerId": peer.id, "incoming": peer.incoming, "host": Self.remoteHost(peer.connection)])
        self.receive(peer)
      case .waiting, .failed, .cancelled:
        // .waiting means "no route right now"; the JS side has its own retry loop.
        self.close(peer)
      default:
        break
      }
    }
    peer.connection.start(queue: queue)
  }

  private func receive(_ peer: Peer) {
    peer.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, !peer.closed else { return }
      if let data, !data.isEmpty {
        peer.buffer.append(data)
        while let newline = peer.buffer.firstIndex(of: 0x0A) {
          let line = peer.buffer[peer.buffer.startIndex..<newline]
          peer.buffer.removeSubrange(peer.buffer.startIndex...newline)
          if let message = String(data: line, encoding: .utf8), !message.isEmpty {
            self.sendEvent("onPeerMessage", ["peerId": peer.id, "message": message])
          }
        }
      }
      if isComplete || error != nil || peer.buffer.count > maxMessageBytes {
        self.close(peer)
      } else {
        self.receive(peer)
      }
    }
  }

  private func close(_ peer: Peer) {
    guard !peer.closed else { return }
    peer.closed = true
    peers.removeValue(forKey: peer.id)
    peer.connection.cancel()
    sendEvent("onPeerClose", ["peerId": peer.id])
  }

  /// The peer's IP address ("" if unknown): the baby unit backs off pairing attempts per address.
  private static func remoteHost(_ connection: NWConnection) -> String {
    guard case let .hostPort(host, _) = connection.currentPath?.remoteEndpoint ?? connection.endpoint else { return "" }
    switch host {
    case .ipv4(let address):
      return "\(address)"
    case .ipv6(let address):
      // A dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d; count them under the IPv4 address.
      if let ipv4 = address.asIPv4 { return "\(ipv4)" }
      return "\(address)"
    case .name(let name, _):
      return name
    @unknown default:
      return "\(host)"
    }
  }

  private static func parameters() -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = 3
    // Notice a vanished peer (Wi-Fi off, device died) within a few seconds.
    tcp.enableKeepalive = true
    tcp.keepaliveIdle = 2
    tcp.keepaliveInterval = 1
    tcp.keepaliveCount = 3
    let parameters = NWParameters(tls: nil, tcp: tcp)
    parameters.allowLocalEndpointReuse = true
    parameters.includePeerToPeer = false
    parameters.prohibitedInterfaceTypes = [.cellular]
    return parameters
  }

  private static func statePayload(_ state: NWListener.State) -> [String: Any] {
    switch state {
    case .ready: return ["state": "ready", "denied": false]
    case .waiting(let error): return ["state": "waiting", "error": error.localizedDescription, "denied": isDenied(error)]
    case .failed(let error): return ["state": "failed", "error": error.localizedDescription, "denied": isDenied(error)]
    case .cancelled: return ["state": "cancelled", "denied": false]
    default: return ["state": "setup", "denied": false]
    }
  }

  private static func statePayload(_ state: NWBrowser.State) -> [String: Any] {
    switch state {
    case .ready: return ["state": "ready", "denied": false]
    case .waiting(let error): return ["state": "waiting", "error": error.localizedDescription, "denied": isDenied(error)]
    case .failed(let error): return ["state": "failed", "error": error.localizedDescription, "denied": isDenied(error)]
    case .cancelled: return ["state": "cancelled", "denied": false]
    default: return ["state": "setup", "denied": false]
    }
  }

  /// Probes every host of this device's /24 on `port`; resolves with the hosts that accept.
  private static func scanSubnet(port: UInt16, promise: Promise) {
    let hosts = subnetHosts()
    guard !hosts.isEmpty else {
      promise.resolve([String]())
      return
    }

    // Everything below runs on this serial queue, so the shared state needs no locks.
    let scanQueue = DispatchQueue(label: "baby-native.scan")
    var found: [String] = []
    var remaining = hosts.count
    var finished = false
    var connections: [NWConnection] = []

    func finish() {
      guard !finished else { return }
      finished = true
      connections.forEach { $0.cancel() }
      promise.resolve(found)
    }

    let tcp = NWProtocolTCP.Options()
    tcp.connectionTimeout = 2
    let parameters = NWParameters(tls: nil, tcp: tcp)
    parameters.prohibitedInterfaceTypes = [.cellular]

    scanQueue.async {
      for host in hosts {
        let connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(integerLiteral: port), using: parameters)
        var settled = false
        connection.stateUpdateHandler = { state in
          guard !settled else { return }
          var accepted = false
          switch state {
          case .ready:
            found.append(host)
            accepted = true
          case .waiting, .failed, .cancelled:
            break
          default:
            return
          }
          settled = true
          connection.cancel()
          remaining -= 1
          if remaining == 0 {
            finish()
          } else if accepted && found.count == 1 {
            // Monitors answer within milliseconds: give others on the network a moment to answer
            // too (a neighbour's may be first), but don't wait for silent addresses to time out.
            scanQueue.asyncAfter(deadline: .now() + 0.3) { finish() }
          }
        }
        connections.append(connection)
        connection.start(queue: scanQueue)
      }
      scanQueue.asyncAfter(deadline: .now() + 3) { finish() }
    }
  }

  /// All other addresses in the /24 of each Wi-Fi / Ethernet interface.
  private static func subnetHosts() -> [String] {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return [] }
    defer { freeifaddrs(list) }

    var hosts: [String] = []
    for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let flags = Int32(entry.pointee.ifa_flags)
      guard let address = entry.pointee.ifa_addr,
            address.pointee.sa_family == UInt8(AF_INET),
            flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
            String(cString: entry.pointee.ifa_name).hasPrefix("en") else { continue }
      let own = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
        UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
      }
      // Home networks are /24; staying within it keeps a scan to ~250 probes even on bigger ones.
      let network = own & 0xFFFF_FF00
      for last in UInt32(1)...254 where network | last != own {
        let ip = network | last
        hosts.append("\(ip >> 24).\(ip >> 16 & 0xFF).\(ip >> 8 & 0xFF).\(ip & 0xFF)")
      }
    }
    return hosts
  }

  private var batteryObservers: [NSObjectProtocol] = []

  private func observeBattery() {
    guard batteryObservers.isEmpty else { return }
    UIDevice.current.isBatteryMonitoringEnabled = true
    let center = NotificationCenter.default
    let send: (Notification) -> Void = { [weak self] _ in self?.sendEvent("onBatteryChange", Self.battery()) }
    batteryObservers = [
      center.addObserver(forName: UIDevice.batteryLevelDidChangeNotification, object: nil, queue: .main, using: send),
      center.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main, using: send),
    ]
  }

  private static func battery() -> [String: Any] {
    let device = UIDevice.current
    let charging = device.batteryState == .charging || device.batteryState == .full
    return ["level": Double(device.batteryLevel), "charging": charging]
  }

  /// react-native-webrtc's video views that can go Picture in Picture.
  private static func videoViews() -> [UIView] {
    let selector = NSSelectorFromString("pipController")
    return UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .compactMap { window in
        findView(in: window) { NSStringFromClass(type(of: $0)) == "RTCVideoView" && $0.responds(to: selector) }
      }
  }

  private static func findView(in root: UIView, where matches: (UIView) -> Bool) -> UIView? {
    if matches(root) { return root }
    for subview in root.subviews {
      if let found = findView(in: subview, where: matches) { return found }
    }
    return nil
  }

  private static func localIPv4Addresses() -> [String] {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return [] }
    defer { freeifaddrs(list) }

    var addresses: [String] = []
    for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let flags = Int32(entry.pointee.ifa_flags)
      // "en*" is Wi-Fi / Ethernet; skips cellular (pdp_ip*), VPN (utun*) and loopback.
      guard let address = entry.pointee.ifa_addr,
            address.pointee.sa_family == UInt8(AF_INET),
            flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
            String(cString: entry.pointee.ifa_name).hasPrefix("en") else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
        addresses.append(String(cString: host))
      }
    }
    return addresses
  }

  private static func isDenied(_ error: NWError) -> Bool {
    if case .dns(let code) = error { return code == dnsPolicyDenied }
    return false
  }
}

/// React Native gives no API for the home indicator or deferred edge gestures,
/// so the root view controller's getters are swapped once at runtime.
private enum ImmersiveMode {
  static var enabled = false
  static var patchedClasses = Set<ObjectIdentifier>()

  static func set(_ value: Bool) {
    guard let root = rootViewController() else { return }
    patch(type(of: root))
    enabled = value
    root.setNeedsUpdateOfHomeIndicatorAutoHidden()
    root.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
  }

  private static func rootViewController() -> UIViewController? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }?
      .rootViewController
  }

  private static func patch(_ cls: AnyClass) {
    guard !patchedClasses.contains(ObjectIdentifier(cls)) else { return }
    patchedClasses.insert(ObjectIdentifier(cls))

    let hideIndicator: @convention(block) (AnyObject) -> Bool = { _ in ImmersiveMode.enabled }
    replaceGetter(cls, #selector(getter: UIViewController.prefersHomeIndicatorAutoHidden),
                  imp_implementationWithBlock(hideIndicator), "B@:")

    let deferEdges: @convention(block) (AnyObject) -> UInt = { _ in
      ImmersiveMode.enabled ? UIRectEdge.all.rawValue : 0
    }
    replaceGetter(cls, #selector(getter: UIViewController.preferredScreenEdgesDeferringSystemGestures),
                  imp_implementationWithBlock(deferEdges), "Q@:")
  }

  private static func replaceGetter(_ cls: AnyClass, _ selector: Selector, _ imp: IMP, _ types: String) {
    if !class_addMethod(cls, selector, imp, types), let method = class_getInstanceMethod(cls, selector) {
      method_setImplementation(method, imp)
    }
  }
}
