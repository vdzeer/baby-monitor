import Accelerate
import CoreVideo
import Foundation

/// Lifts a dark camera picture before it's encoded: a gamma curve raises the shadows, the black
/// level is pulled back down afterwards so the picture doesn't turn into grey haze, and colour is
/// toned down in proportion, because in the dark the sensor's colour is mostly noise anyway.
///
/// Works on the camera's bi-planar YUV frames with lookup tables (vImage), so a 1080p frame
/// costs about a millisecond. No WebRTC or UIKit here: the same code runs in a Mac test harness.
final class NightFilter {
  enum Mode: String {
    case off, auto, on
  }

  var mode: Mode = .auto
  /// 0 leaves the picture alone, 1 is the strongest lift. Follows the room's darkness smoothly.
  private(set) var strength: Float = 0

  private var frameCount = 0
  private var pool: CVPixelBufferPool?
  private var poolSize = (width: 0, height: 0, format: OSType(0))
  private var lumaTable = [UInt8](repeating: 0, count: 256)
  private var chromaTable = [UInt8](repeating: 0, count: 256)
  private var tableStrength: Float = -1
  private var tableVideoRange = false

  /// A brightened copy of `buffer`, or nil when it should pass through untouched.
  func process(_ buffer: CVPixelBuffer) -> CVPixelBuffer? {
    let format = CVPixelBufferGetPixelFormatType(buffer)
    let videoRange = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    guard videoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange else { return nil }

    // Measuring a few times a second is plenty; light in a nursery changes slowly.
    if frameCount % 6 == 0 { updateStrength(measuring: buffer, videoRange: videoRange) }
    frameCount += 1
    guard strength > 0.03, let output = makeBuffer(like: buffer) else { return nil }

    // Tables change in small steps, so they're rebuilt only a few times per transition.
    let step = (strength * 50).rounded() / 50
    if step != tableStrength || videoRange != tableVideoRange {
      buildTables(strength: step, videoRange: videoRange)
    }

    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    CVPixelBufferLockBaseAddress(output, [])
    defer {
      CVPixelBufferUnlockBaseAddress(output, [])
      CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
    }
    // Plane 0 is luma; plane 1 interleaves Cb and Cr, which share one table.
    for (plane, table) in [(0, lumaTable), (1, chromaTable)] {
      guard let source = CVPixelBufferGetBaseAddressOfPlane(buffer, plane),
            let target = CVPixelBufferGetBaseAddressOfPlane(output, plane) else { return nil }
      let bytesWide = CVPixelBufferGetWidthOfPlane(buffer, plane) * (plane == 0 ? 1 : 2)
      var input = vImage_Buffer(
        data: source,
        height: vImagePixelCount(CVPixelBufferGetHeightOfPlane(buffer, plane)),
        width: vImagePixelCount(bytesWide),
        rowBytes: CVPixelBufferGetBytesPerRowOfPlane(buffer, plane))
      var result = vImage_Buffer(
        data: target,
        height: input.height,
        width: input.width,
        rowBytes: CVPixelBufferGetBytesPerRowOfPlane(output, plane))
      let status = table.withUnsafeBufferPointer {
        vImageTableLookUp_Planar8(&input, &result, $0.baseAddress!, vImage_Flags(kvImageNoFlags))
      }
      guard status == kvImageNoError else { return nil }
    }
    CVBufferPropagateAttachments(buffer, output)
    return output
  }

  private func updateStrength(measuring buffer: CVPixelBuffer, videoRange: Bool) {
    let target: Float
    switch mode {
    case .off:
      target = 0
    case .auto, .on:
      guard let brightness = averageBrightness(buffer, videoRange: videoRange) else { return }
      // Start lifting below about a third of full brightness; full strength in a dark room.
      let darkness = min(1, max(0, (0.34 - brightness) / (0.34 - 0.07)))
      target = mode == .on ? max(darkness, 0.7) : darkness
    }
    strength += (target - strength) * 0.3
  }

  /// Mean luma, 0...1, from a sparse grid of samples.
  private func averageBrightness(_ buffer: CVPixelBuffer, videoRange: Bool) -> Float? {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
    let luma = base.assumingMemoryBound(to: UInt8.self)
    let width = CVPixelBufferGetWidthOfPlane(buffer, 0)
    let height = CVPixelBufferGetHeightOfPlane(buffer, 0)
    let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    var sum = 0
    var count = 0
    for y in stride(from: 0, to: height, by: 16) {
      for x in stride(from: 0, to: width, by: 16) {
        sum += Int(luma[y * rowBytes + x])
        count += 1
      }
    }
    guard count > 0 else { return nil }
    let mean = Float(sum) / Float(count)
    return videoRange ? max(0, (mean - 16) / 219) : mean / 255
  }

  private func buildTables(strength: Float, videoRange: Bool) {
    let (low, span): (Float, Float) = videoRange ? (16, 219) : (0, 255)
    let gamma = 1 - 0.62 * strength
    let black = 0.03 * strength
    // After the lift, pull the old blacks back down so the picture keeps its contrast.
    let floor = 0.12 * strength
    let saturation = 1 - 0.6 * strength
    for value in 0..<256 {
      let level = min(1, max(0, (Float(value) - low) / span))
      let raised = pow(max(0, level - black) / (1 - black), gamma)
      let lifted = max(0, raised - floor) / (1 - floor)
      lumaTable[value] = UInt8(min(255, max(0, (low + lifted * span).rounded())))
      chromaTable[value] = UInt8(min(255, max(0, (128 + (Float(value) - 128) * saturation).rounded())))
    }
    tableStrength = strength
    tableVideoRange = videoRange
  }

  private func makeBuffer(like buffer: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let format = CVPixelBufferGetPixelFormatType(buffer)
    if pool == nil || poolSize != (width, height, format) {
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: format,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      ]
      pool = nil
      CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
      poolSize = (width, height, format)
    }
    guard let pool else { return nil }
    var output: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output)
    return output
  }
}
