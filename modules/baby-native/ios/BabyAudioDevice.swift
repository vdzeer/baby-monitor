import AVFoundation
import AudioToolbox
import ExpoModulesCore
import WebRTC

/// Replaces WebRTC's default iOS audio device.
///
/// - Parents only listen: plain RemoteIO output with the microphone input switched off. (WebRTC's
///   own device always opens the microphone, so iOS showed the microphone indicator on parent
///   phones.) The session is still play-and-record in video-chat mode: that's what iOS requires
///   before it lets a video call go Picture in Picture.
/// - The baby unit records through voice-processing I/O and plays its sleep sounds through the
///   same unit, so iOS's echo canceller removes the music from the microphone: parents hear
///   the baby rather than the lullaby, and loud-sound alerts still work with music on.
///
/// RTCAudioDevice methods are called on the native audio module's thread; everything that
/// rebuilds the audio unit runs there too.
final class BabyAudioDevice: NSObject, RTCAudioDevice {
  static let shared = BabyAudioDevice()

  /// Hands this device to react-native-webrtc before it creates its peer connection factory.
  /// Goes through the ObjC runtime to avoid importing that pod's non-modular headers.
  static func install() {
    guard let optionsClass = NSClassFromString("WebRTCModuleOptions"),
          let options = (optionsClass as AnyObject).perform(NSSelectorFromString("sharedInstance"))?
            .takeUnretainedValue() as? NSObject else { return }
    options.setValue(shared, forKey: "audioDevice")
  }

  // The I/O units convert to and from the hardware rate, so WebRTC can always see this one.
  private let sampleRate: Double = 48_000
  private var ioBufferDuration: TimeInterval = 0.01

  private var delegate: RTCAudioDeviceDelegate?
  private var unit: AudioComponentInstance?
  private var playoutInitialized = false
  private var playing = false
  private var recordingInitialized = false
  private var recording = false
  private var observers: [NSObjectProtocol] = []

  // Sleep sounds (baby unit).
  private var synth: SleepSynth?
  /// True while a sound plays or fades out.
  private var soundOn = false
  private var soundGeneration = 0
  private static let scratchFrames = 4096
  private let scratch = UnsafeMutablePointer<Float>.allocate(capacity: scratchFrames)

  // Loud-sound detection (baby unit).
  /// How far above the room's usual noise a sound must rise, in dB; 0 turns detection off.
  var loudThreshold: Float = 0
  var onLoudSound: (() -> Void)?
  private var level: Float = -90
  private var noiseFloor: Float = -60
  private var loudFrames = 0
  private var lastLoudReport: CFTimeInterval = 0

  // Playout level (parents), for the sound meter.
  var onPlayoutLevel: ((Double) -> Void)?
  private var playoutEnergy: Float = 0
  private var playoutFrames = 0

  /// Created once: the audio thread must not allocate a new block on every callback.
  private lazy var renderRecorded: RTCAudioDeviceRenderRecordedDataBlock = { [unowned self] flags, timestamp, bus, frames, data, _ in
    guard let unit = self.unit else { return noErr }
    let status = AudioUnitRender(unit, flags, timestamp, UInt32(bus), frames, data)
    guard status == noErr,
          let samples = UnsafeMutableAudioBufferListPointer(data).first?.mData?.assumingMemoryBound(to: Int16.self)
    else { return status }
    if self.loudThreshold > 0 { self.measureLoudness(samples, frames: Int(frames)) }
    CryDetector.shared.append(samples, count: Int(frames))
    return status
  }

  // MARK: - RTCAudioDevice

  var deviceInputSampleRate: Double { sampleRate }
  var inputIOBufferDuration: TimeInterval { ioBufferDuration }
  var inputNumberOfChannels: Int { 1 }
  var inputLatency: TimeInterval { AVAudioSession.sharedInstance().inputLatency }
  var deviceOutputSampleRate: Double { sampleRate }
  var outputIOBufferDuration: TimeInterval { ioBufferDuration }
  var outputNumberOfChannels: Int { 1 }
  var outputLatency: TimeInterval { AVAudioSession.sharedInstance().outputLatency }
  var isInitialized: Bool { delegate != nil }
  var isPlayoutInitialized: Bool { playoutInitialized }
  var isPlaying: Bool { playing }
  var isRecordingInitialized: Bool { recordingInitialized }
  var isRecording: Bool { recording }

  func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
    self.delegate = delegate
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
        self?.onInterruption(note)
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
        self?.onAudioThread { self?.restart() }
      },
    ]
    return true
  }

  func terminateDevice() -> Bool {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    playing = false
    recording = false
    playoutInitialized = false
    recordingInitialized = false
    rebuild()
    delegate = nil
    return true
  }

  func initializePlayout() -> Bool {
    playoutInitialized = activateSession()
    return playoutInitialized
  }

  func startPlayout() -> Bool {
    playing = true
    return rebuild()
  }

  func stopPlayout() -> Bool {
    playing = false
    playoutInitialized = false
    rebuild()
    return true
  }

  func initializeRecording() -> Bool {
    // Recording needs the play-and-record category, so the session is set up again.
    recordingInitialized = true
    guard activateSession() else {
      recordingInitialized = false
      return false
    }
    return true
  }

  func startRecording() -> Bool {
    recording = true
    return rebuild()
  }

  func stopRecording() -> Bool {
    recording = false
    recordingInitialized = false
    activateSession()
    rebuild()
    return true
  }

  // MARK: - Sleep sounds

  func startSleepSound(kind: String, volume: Double) {
    guard let kind = SleepSynth.Kind(rawValue: kind) else { return }
    onAudioThread {
      let synth = self.synth ?? SleepSynth(sampleRate: self.sampleRate)
      self.synth = synth
      synth.kind = kind
      synth.volume = Float(volume)
      self.soundGeneration += 1
      if !self.soundOn {
        self.soundOn = true
        self.activateSession()
        self.rebuild()
      }
    }
  }

  func setSleepSoundVolume(_ volume: Double) {
    onAudioThread { if self.soundOn { self.synth?.volume = Float(volume) } }
  }

  /// Fades out, then releases the speaker if nothing else needs the audio unit.
  func stopSleepSound() {
    onAudioThread {
      guard self.soundOn else { return }
      self.synth?.volume = 0
      self.soundGeneration += 1
      let generation = self.soundGeneration
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        self.onAudioThread {
          guard generation == self.soundGeneration else { return }
          self.soundOn = false
          self.activateSession()
          self.rebuild()
        }
      }
    }
  }

  // MARK: - Session and audio unit

  private func onAudioThread(_ work: @escaping () -> Void) {
    if let delegate {
      delegate.dispatchAsync(work)
    } else {
      DispatchQueue.main.async(execute: work)
    }
  }

  /// Play-and-record in video-chat mode for both roles: the baby unit needs it for echo
  /// cancellation, and parents need it for Picture in Picture (a plain playback session makes iOS
  /// silently refuse PiP for a call). The category alone doesn't turn the microphone on; only an
  /// audio unit with input enabled does, and parents never build one.
  @discardableResult
  private func activateSession() -> Bool {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: .videoChat, options: [.defaultToSpeaker, .allowBluetoothA2DP])
      try session.setPreferredIOBufferDuration(0.01)
      try session.setActive(true)
      ioBufferDuration = session.ioBufferDuration
      return true
    } catch {
      NSLog("[BabyAudioDevice] audio session: %@", error.localizedDescription)
      return false
    }
  }

  private func restart() {
    guard playing || recording || soundOn else { return }
    activateSession()
    rebuild()
  }

  /// (Re)creates the I/O unit for the current mix of playout, recording and sleep sounds.
  /// Input can only be switched on or off while the unit is uninitialized.
  @discardableResult
  private func rebuild() -> Bool {
    if let unit {
      AudioOutputUnitStop(unit)
      AudioUnitUninitialize(unit)
      AudioComponentInstanceDispose(unit)
      self.unit = nil
      // Callbacks will come from a new I/O thread.
      delegate?.dispatchSync {
        self.delegate?.notifyAudioOutputInterrupted()
        self.delegate?.notifyAudioInputInterrupted()
      }
    }
    guard playing || recording || soundOn else {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      return true
    }

    var description = AudioComponentDescription(
      componentType: kAudioUnitType_Output,
      // Voice processing only where the microphone is on: it's what cancels our own music.
      componentSubType: recording ? kAudioUnitSubType_VoiceProcessingIO : kAudioUnitSubType_RemoteIO,
      componentManufacturer: kAudioUnitManufacturer_Apple,
      componentFlags: 0,
      componentFlagsMask: 0)
    guard let component = AudioComponentFindNext(nil, &description) else { return false }
    var created: AudioComponentInstance?
    guard AudioComponentInstanceNew(component, &created) == noErr, let unit = created else { return false }

    var format = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      mBytesPerPacket: 2,
      mFramesPerPacket: 1,
      mBytesPerFrame: 2,
      mChannelsPerFrame: 1,
      mBitsPerChannel: 16,
      mReserved: 0)
    let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let callbackSize = UInt32(MemoryLayout<AURenderCallbackStruct>.size)
    let context = Unmanaged.passUnretained(self).toOpaque()
    // Voice processing needs its output running as the echo reference, even when silent.
    let outputOn = playing || soundOn || recording
    var output: UInt32 = outputOn ? 1 : 0
    var input: UInt32 = recording ? 1 : 0

    func check(_ status: OSStatus, _ step: String) -> Bool {
      if status != noErr { NSLog("[BabyAudioDevice] %@ failed: %d", step, status) }
      return status == noErr
    }
    var ok = check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &output, 4), "enable output")
      && check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &input, 4), "enable input")
    if ok && outputOn {
      var callback = AURenderCallbackStruct(inputProc: outputCallback, inputProcRefCon: context)
      ok = check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format, formatSize), "output format")
        && check(AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &callback, callbackSize), "render callback")
    }
    if ok && recording {
      var callback = AURenderCallbackStruct(inputProc: inputCallback, inputProcRefCon: context)
      ok = check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, formatSize), "input format")
        && check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1, &callback, callbackSize), "input callback")
    }
    ok = ok && check(AudioUnitInitialize(unit), "initialize") && check(AudioOutputUnitStart(unit), "start")
    guard ok else {
      AudioComponentInstanceDispose(unit)
      return false
    }
    self.unit = unit
    return true
  }

  private func onInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    onAudioThread {
      if type == .began {
        if let unit = self.unit { AudioOutputUnitStop(unit) }
      } else {
        // After a call or an alarm, come back on our own; the baby is still there.
        self.restart()
      }
    }
  }

  // MARK: - Audio thread

  fileprivate func renderOutput(
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ timestamp: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32,
    _ data: UnsafeMutablePointer<AudioBufferList>
  ) -> OSStatus {
    let buffers = UnsafeMutableAudioBufferListPointer(data)
    var status = noErr
    if playing, let delegate {
      status = delegate.getPlayoutData(flags, timestamp, Int(bus), frames, data)
      if let samples = buffers.first?.mData?.assumingMemoryBound(to: Int16.self) {
        meterPlayout(samples, frames: Int(frames))
      }
    } else {
      for buffer in buffers { memset(buffer.mData, 0, Int(buffer.mDataByteSize)) }
    }
    if soundOn, let synth, let samples = buffers.first?.mData?.assumingMemoryBound(to: Int16.self) {
      var done = 0
      while done < Int(frames) {
        let chunk = min(Self.scratchFrames, Int(frames) - done)
        synth.render(scratch, frames: chunk)
        for index in 0..<chunk {
          let mixed = Float(samples[done + index]) + scratch[index] * 32767
          samples[done + index] = Int16(max(-32768, min(32767, mixed)))
        }
        done += chunk
      }
    }
    return status
  }

  fileprivate func deliverRecording(
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ timestamp: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32
  ) -> OSStatus {
    guard let delegate else { return noErr }
    return delegate.deliverRecordedData(flags, timestamp, Int(bus), frames, nil, nil, renderRecorded)
  }

  /// About eight times a second, how loud the baby unit's sound is: 0 (silence) ... 1 (loud).
  private func meterPlayout(_ samples: UnsafeMutablePointer<Int16>, frames: Int) {
    for index in 0..<frames {
      let value = Float(samples[index]) / 32768
      playoutEnergy += value * value
    }
    playoutFrames += frames
    guard playoutFrames >= Int(sampleRate / 8) else { return }
    let decibels = 10 * log10(playoutEnergy / Float(playoutFrames) + 1e-10)
    playoutEnergy = 0
    playoutFrames = 0
    // −60 dBFS and below reads as silence, −12 dBFS as full scale.
    let level = Double(min(1, max(0, (decibels + 60) / 48)))
    DispatchQueue.main.async { self.onPlayoutLevel?(level) }
  }

  /// Follows the room's usual noise level slowly and reports a sound that stays well above it
  /// for about a second: crying, not a door or a cough.
  private func measureLoudness(_ samples: UnsafeMutablePointer<Int16>, frames: Int) {
    guard frames > 0 else { return }
    var sum: Float = 0
    for index in 0..<frames {
      let value = Float(samples[index]) / 32768
      sum += value * value
    }
    let decibels = 10 * log10(sum / Float(frames) + 1e-10)
    level += (decibels - level) * 0.3
    // The floor drops quickly into silence and rises only slowly, so steady noise becomes the norm.
    noiseFloor += (level - noiseFloor) * (level < noiseFloor ? 0.05 : 0.0004)
    noiseFloor = max(noiseFloor, -80)

    if level > noiseFloor + loudThreshold {
      loudFrames += frames
    } else {
      loudFrames = max(0, loudFrames - frames * 2)
    }
    let now = CACurrentMediaTime()
    if loudFrames >= Int(sampleRate) && now - lastLoudReport > 10 {
      lastLoudReport = now
      loudFrames = 0
      DispatchQueue.main.async { self.onLoudSound?() }
    }
  }
}

private let outputCallback: AURenderCallback = { context, flags, timestamp, bus, frames, data in
  guard let data else { return noErr }
  return Unmanaged<BabyAudioDevice>.fromOpaque(context).takeUnretainedValue()
    .renderOutput(flags, timestamp, bus, frames, data)
}

private let inputCallback: AURenderCallback = { context, flags, timestamp, bus, frames, _ in
  Unmanaged<BabyAudioDevice>.fromOpaque(context).takeUnretainedValue()
    .deliverRecording(flags, timestamp, bus, frames)
}

/// Installs the audio device before any JS (and so any WebRTC) code runs.
public class BabyNativeAppDelegateSubscriber: BaseExpoAppDelegateSubscriber, ExpoAppDelegateSubscriberProtocol {
  @MainActor
  public func subscriberDidRegister() {
    BabyAudioDevice.install()
  }
}
