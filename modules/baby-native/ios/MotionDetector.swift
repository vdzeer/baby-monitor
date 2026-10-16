import CoreVideo
import Foundation
import QuartzCore
import WebRTC

/// Plugs into react-native-webrtc's video-effects hook, so it sees every camera frame the
/// baby unit sends without opening the camera a second time. It compares a coarse grayscale
/// thumbnail with the previous one and reports how much of the picture changed.
final class MotionDetector: NSObject {
  static let shared = MotionDetector()
  /// The name JS passes to `track._setVideoEffects([...])`.
  static let processorName = "babyMotion"

  /// Fraction of the picture that must change to count as motion; 0 turns detection off.
  var threshold: Double = 0
  var onMotion: ((Double) -> Void)?

  private let columns = 48
  private let rows = 27
  private let sampleInterval: CFTimeInterval = 0.4
  // Cells are averages, so small values are already real change rather than sensor noise.
  private let cellChange = 15
  // Nearly the whole picture changing at once is light switched on/off or auto-exposure.
  private let lightingChange = 0.6

  private var previous: [UInt8] = []
  private var lastSample: CFTimeInterval = 0
  private var streak = 0

  /// Registers with react-native-webrtc's ProcessorProvider through the ObjC runtime,
  /// which avoids importing that pod's non-modular headers into Swift.
  static func register() {
    guard let provider = NSClassFromString("ProcessorProvider") else { return }
    _ = (provider as AnyObject).perform(
      NSSelectorFromString("addProcessor:forName:"), with: shared, with: processorName)
  }

  @objc(capturer:didCaptureVideoFrame:)
  func capturer(_ capturer: RTCVideoCapturer, didCaptureVideoFrame frame: RTCVideoFrame) -> RTCVideoFrame {
    analyze(frame)
    return frame
  }

  // Runs on the camera's serial capture queue.
  private func analyze(_ frame: RTCVideoFrame) {
    guard threshold > 0 else {
      previous = []
      streak = 0
      return
    }
    let now = CACurrentMediaTime()
    guard now - lastSample >= sampleInterval else { return }
    lastSample = now

    guard let pixelBuffer = (frame.buffer as? RTCCVPixelBuffer)?.pixelBuffer,
          let thumbnail = thumbnail(of: pixelBuffer) else { return }
    defer { previous = thumbnail }
    guard previous.count == thumbnail.count else { return }

    var changed = 0
    for index in thumbnail.indices where abs(Int(thumbnail[index]) - Int(previous[index])) > cellChange {
      changed += 1
    }
    let fraction = Double(changed) / Double(thumbnail.count)

    if fraction > lightingChange {
      streak = 0
      return
    }
    streak = fraction >= threshold ? streak + 1 : 0
    // Two samples in a row (~0.8 s) filter out one-off flicker; one report per burst of movement.
    if streak == 2 { onMotion?(fraction) }
  }

  /// Average luma of each grid cell. Camera frames are bi-planar YUV, whose first plane is grayscale.
  private func thumbnail(of buffer: CVPixelBuffer) -> [UInt8]? {
    let format = CVPixelBufferGetPixelFormatType(buffer)
    guard format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange else { return nil }

    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }

    let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
    let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
    let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    let luma = base.assumingMemoryBound(to: UInt8.self)
    let cellWidth = width / columns
    let cellHeight = height / rows
    guard cellWidth > 0, cellHeight > 0 else { return nil }

    // Sample a 4×4 lattice inside each cell: cheap, and averaging smooths low-light noise.
    let stepX = max(1, cellWidth / 4)
    let stepY = max(1, cellHeight / 4)
    var result = [UInt8](repeating: 0, count: columns * rows)
    for row in 0..<rows {
      for column in 0..<columns {
        var sum = 0
        var count = 0
        var y = row * cellHeight
        while y < (row + 1) * cellHeight {
          var x = column * cellWidth
          while x < (column + 1) * cellWidth {
            sum += Int(luma[y * bytesPerRow + x])
            count += 1
            x += stepX
          }
          y += stepY
        }
        result[row * columns + column] = UInt8(sum / max(count, 1))
      }
    }
    return result
  }
}
