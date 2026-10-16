import AVFoundation
import Foundation
import WebRTC

/// Night mode for the baby unit's camera, plugged into react-native-webrtc's video-effects hook
/// (like MotionDetector). When the room gets dark it lets the camera keep its shutter open longer,
/// which gathers real light, and lifts what's left with NightFilter before the frame is encoded.
final class NightVision: NSObject {
  static let shared = NightVision()
  /// The name JS passes to `track._setVideoEffects([...])`.
  static let processorName = "babyNight"

  let filter = NightFilter()
  private let cameraQueue = DispatchQueue(label: "baby-native.night-camera")
  private var cameraAtNight = false
  private var frames = 0

  /// Registers with react-native-webrtc's ProcessorProvider through the ObjC runtime,
  /// which avoids importing that pod's non-modular headers into Swift.
  static func register() {
    guard let provider = NSClassFromString("ProcessorProvider") else { return }
    _ = (provider as AnyObject).perform(
      NSSelectorFromString("addProcessor:forName:"), with: shared, with: processorName)
  }

  // Runs on the camera's serial capture queue.
  @objc(capturer:didCaptureVideoFrame:)
  func capturer(_ capturer: RTCVideoCapturer, didCaptureVideoFrame frame: RTCVideoFrame) -> RTCVideoFrame {
    guard let pixelBuffer = (frame.buffer as? RTCCVPixelBuffer)?.pixelBuffer else { return frame }
    let lifted = filter.process(pixelBuffer)
    frames += 1
    if frames % 30 == 0 { adjustCamera(capturer) }
    guard let lifted else { return frame }
    return RTCVideoFrame(
      buffer: RTCCVPixelBuffer(pixelBuffer: lifted), rotation: frame.rotation, timeStampNs: frame.timeStampNs)
  }

  private func adjustCamera(_ capturer: RTCVideoCapturer) {
    guard let camera = capturer as? RTCCameraVideoCapturer,
          let device = camera.captureSession.inputs
            .compactMap({ ($0 as? AVCaptureDeviceInput)?.device })
            .first(where: { $0.hasMediaType(.video) }) else { return }
    // Hysteresis, so a room at the threshold doesn't flip the camera back and forth.
    let night = cameraAtNight ? filter.strength > 0.1 : filter.strength > 0.35
    // WebRTC resets the frame rate when it restarts the camera (switching cameras, quality):
    // re-apply night settings if that happened.
    let reset = night && device.activeVideoMaxFrameDuration == device.activeVideoMinFrameDuration
    guard night != cameraAtNight || reset else { return }
    cameraAtNight = night
    cameraQueue.async { Self.configure(device, night: night) }
  }

  private static func configure(_ device: AVCaptureDevice, night: Bool) {
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      let fastest = device.activeVideoMinFrameDuration  // what WebRTC asked for, e.g. 1/30 s
      if night {
        // Let auto exposure slow down to 10 fps: up to three times the light of 30 fps.
        // A sleeping baby barely moves, so smoothness matters less than seeing anything.
        let slowest = device.activeFormat.videoSupportedFrameRateRanges.map(\.maxFrameDuration).max() ?? fastest
        let target = CMTimeMinimum(CMTime(value: 1, timescale: 10), slowest)
        device.activeVideoMaxFrameDuration = CMTimeMaximum(target, fastest)
        if device.isLowLightBoostSupported { device.automaticallyEnablesLowLightBoostWhenAvailable = true }
        device.setExposureTargetBias(min(1, device.maxExposureTargetBias))
      } else {
        device.activeVideoMaxFrameDuration = fastest
        if device.isLowLightBoostSupported { device.automaticallyEnablesLowLightBoostWhenAvailable = false }
        device.setExposureTargetBias(0)
      }
    } catch {
      NSLog("[NightVision] camera: %@", error.localizedDescription)
    }
  }
}
