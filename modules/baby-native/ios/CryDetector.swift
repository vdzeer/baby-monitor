import AVFoundation
import Foundation
import SoundAnalysis
import os

/// Listens for a baby crying with Apple's built-in sound classifier, which tells crying apart
/// from other loud sounds (a cough, a door, a dog). It hears the baby unit's microphone after
/// echo cancellation, so the unit's own sleep sounds don't count.
///
/// The audio thread only copies samples into a ring buffer; classification runs on its own queue.
final class CryDetector: NSObject, SNResultsObserving {
  static let shared = CryDetector()

  /// Classifier confidence (0...1) that counts as crying; 0 turns detection off.
  var threshold: Double = 0 {
    didSet { threshold > 0 ? start() : stop() }
  }
  var onCry: (() -> Void)?

  private static let labels = ["baby_crying", "crying_sobbing"]
  private let sampleRate: Double = 48_000
  private let queue = DispatchQueue(label: "baby-native.cry")
  private var timer: DispatchSourceTimer?
  private var analyzer: SNAudioStreamAnalyzer?
  private var position: AVAudioFramePosition = 0
  private var streak = 0
  private var lastReport = Date.distantPast

  // Ring buffer shared with the audio thread, guarded by an unfair lock held only for a memcpy.
  private let ringCapacity = 48_000 * 2
  private let ring: UnsafeMutablePointer<Float>
  private var writeIndex = 0
  private var available = 0
  // A lock must live at a fixed address, so not as a plain stored property.
  private let lock: UnsafeMutablePointer<os_unfair_lock> = {
    let lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
    lock.initialize(to: os_unfair_lock())
    return lock
  }()

  override init() {
    ring = .allocate(capacity: ringCapacity)
    ring.initialize(repeating: 0, count: ringCapacity)
    super.init()
  }

  /// Audio thread: 16-bit mono microphone samples at 48 kHz.
  func append(_ samples: UnsafePointer<Int16>, count: Int) {
    guard threshold > 0 else { return }
    os_unfair_lock_lock(lock)
    for index in 0..<count {
      ring[writeIndex] = Float(samples[index]) / 32768
      writeIndex = (writeIndex + 1) % ringCapacity
    }
    available = min(ringCapacity, available + count)
    os_unfair_lock_unlock(lock)
  }

  private func start() {
    queue.async {
      guard self.timer == nil,
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: self.sampleRate, channels: 1, interleaved: false),
            let request = try? SNClassifySoundRequest(classifierIdentifier: .version1) else { return }
      let analyzer = SNAudioStreamAnalyzer(format: format)
      do {
        try analyzer.add(request, withObserver: self)
      } catch {
        NSLog("[CryDetector] %@", error.localizedDescription)
        return
      }
      self.analyzer = analyzer
      self.position = 0
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
      timer.setEventHandler { [weak self] in self?.drain(format: format) }
      timer.resume()
      self.timer = timer
    }
  }

  private func stop() {
    queue.async {
      self.timer?.cancel()
      self.timer = nil
      self.analyzer?.removeAllRequests()
      self.analyzer = nil
      self.streak = 0
    }
  }

  /// Moves whatever the microphone produced since last time into the classifier.
  private func drain(format: AVAudioFormat) {
    guard let analyzer else { return }
    os_unfair_lock_lock(lock)
    let count = available
    guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
          let channel = buffer.floatChannelData?[0] else {
      os_unfair_lock_unlock(lock)
      return
    }
    let start = (writeIndex - count + ringCapacity) % ringCapacity
    let firstPart = min(count, ringCapacity - start)
    channel.update(from: ring + start, count: firstPart)
    if firstPart < count { (channel + firstPart).update(from: ring, count: count - firstPart) }
    available = 0
    os_unfair_lock_unlock(lock)

    buffer.frameLength = AVAudioFrameCount(count)
    analyzer.analyze(buffer, atAudioFramePosition: position)
    position += AVAudioFramePosition(count)
  }

  // MARK: - SNResultsObserving (on the analyzer's thread)

  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let result = result as? SNClassificationResult else { return }
    let confidence = Self.labels.compactMap { result.classification(forIdentifier: $0)?.confidence }.max() ?? 0
    // Two windows in a row (a few seconds of crying), then quiet for a while before the next report.
    streak = confidence >= threshold ? streak + 1 : 0
    guard streak >= 2, Date().timeIntervalSince(lastReport) > 20 else { return }
    lastReport = Date()
    streak = 0
    DispatchQueue.main.async { self.onCry?() }
  }

  func request(_ request: SNRequest, didFailWithError error: Error) {
    NSLog("[CryDetector] %@", error.localizedDescription)
  }
}
