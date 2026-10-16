import Foundation

/// Sleep sounds synthesized sample by sample: nothing to license or download, and no loop
/// you can hear repeat. Plain Swift with no audio framework, so the same code also renders
/// offline previews on a Mac.
///
/// `render` runs on the real-time audio thread: it must not allocate or lock.
final class SleepSynth {
  enum Kind: String {
    /// Rain on the window, a slow wandering piano, a fire crackling now and then.
    case rainPiano
    /// A music box playing Brahms' lullaby and "Twinkle, Twinkle" (both public domain).
    case lullaby
    case rain
    case ocean
    /// Pink noise: steadier and softer on the ear than true white noise.
    case noise
  }

  /// Set from any thread; takes effect on the next rendered sample.
  var kind: Kind = .rain
  /// 0...1. Changes glide in over about a second instead of jumping.
  var volume: Float = 0

  private let sampleRate: Float
  private var gain: Float = 0
  private let gainGlide: Float

  init(sampleRate: Double) {
    self.sampleRate = Float(sampleRate)
    gainGlide = 1 - exp(-1 / (0.8 * Float(sampleRate)))
    voices = .allocate(capacity: Self.voiceCount)
    voices.initialize(repeating: Voice(), count: Self.voiceCount)
    echoA = DelayLine(seconds: 0.29, sampleRate: sampleRate, feedback: 0.42)
    echoB = DelayLine(seconds: 0.47, sampleRate: sampleRate, feedback: 0.36)
    rainTone = OnePole(cutoff: 2600, sampleRate: sampleRate)
    rainRumble = OnePole(cutoff: 180, sampleRate: sampleRate)
    dropTone = OnePole(cutoff: 900, sampleRate: sampleRate)
    oceanTone = OnePole(cutoff: 650, sampleRate: sampleRate)
    noiseTone = OnePole(cutoff: 5500, sampleRate: sampleRate)
    crackleTone = OnePole(cutoff: 1500, sampleRate: sampleRate)
  }

  deinit {
    voices.deinitialize(count: Self.voiceCount)
    voices.deallocate()
  }

  func render(_ output: UnsafeMutablePointer<Float>, frames: Int) {
    let kind = self.kind
    let target = volume * volume * 1.4  // perceptual curve; presets peak around −6 dBFS at full volume
    for index in 0..<frames {
      var sample: Float
      switch kind {
      case .rainPiano:
        tickPiano()
        // Piano in front, rain and fire behind it.
        sample = rain() * 0.17 + crackle() * 0.2 + withEcho(voicesSample()) * 0.5
      case .lullaby:
        tickMusicBox()
        sample = withEcho(voicesSample()) * 0.45 + pink() * 0.015
      case .rain:
        sample = rain()
      case .ocean:
        sample = ocean()
      case .noise:
        sample = noiseTone.process(pink()) * 0.45
      }
      gain += (target - gain) * gainGlide
      output[index] = max(-1, min(1, sample * gain))
    }
  }

  // MARK: - Noise sources

  private var seed: UInt32 = 0x9E37_79B9

  /// Uniform in -1...1 (xorshift: fast and allocation-free).
  @inline(__always) private func white() -> Float {
    seed ^= seed << 13
    seed ^= seed >> 17
    seed ^= seed << 5
    return Float(seed) / Float(UInt32.max) * 2 - 1
  }

  @inline(__always) private func chance(perSecond rate: Float) -> Bool {
    (white() + 1) * 0.5 < rate / sampleRate
  }

  private var pinkState: (Float, Float, Float, Float, Float, Float, Float) = (0, 0, 0, 0, 0, 0, 0)

  /// Paul Kellet's refined pink noise filter.
  @inline(__always) private func pink() -> Float {
    let w = white()
    pinkState.0 = 0.99886 * pinkState.0 + w * 0.0555179
    pinkState.1 = 0.99332 * pinkState.1 + w * 0.0750759
    pinkState.2 = 0.96900 * pinkState.2 + w * 0.1538520
    pinkState.3 = 0.86650 * pinkState.3 + w * 0.3104856
    pinkState.4 = 0.55000 * pinkState.4 + w * 0.5329522
    pinkState.5 = -0.7616 * pinkState.5 - w * 0.0168980
    let out = pinkState.0 + pinkState.1 + pinkState.2 + pinkState.3 + pinkState.4 + pinkState.5 + pinkState.6 + w * 0.5362
    pinkState.6 = w * 0.115926
    return out * 0.11
  }

  private var brown: Float = 0

  @inline(__always) private func brownNoise() -> Float {
    brown = (brown + 0.02 * white()) / 1.02
    return brown * 3.5
  }

  // MARK: - Rain, ocean, fire

  private var rainTone: OnePole
  private var rainRumble: OnePole
  private var dropTone: OnePole
  private var dropLevel: Float = 0
  private var dropDecay: Float = 0
  private var gustPhase: Float = 0

  private func rain() -> Float {
    // A hiss of countless small drops, without the low rumble.
    let hiss = rainTone.process(pink())
    let bed = hiss - rainRumble.process(hiss)
    // Now and then a single heavier drop close by.
    if chance(perSecond: 14) {
      dropLevel = 0.25 + 0.5 * (white() + 1) * 0.5
      dropDecay = exp(-1 / ((0.006 + 0.01 * (white() + 1) * 0.5) * sampleRate))
    }
    dropLevel *= dropDecay
    let drop = dropTone.process(white()) * dropLevel
    // Slow gusts so it breathes like real rain.
    gustPhase += 0.11 / sampleRate
    if gustPhase > 1 { gustPhase -= 1 }
    let gust = 0.85 + 0.15 * sin(2 * .pi * gustPhase)
    return (bed * 1.6 + drop * 0.9) * gust
  }

  private var oceanTone: OnePole
  private var wavePhase: Float = 0
  private var waveSeconds: Float = 9

  private func ocean() -> Float {
    // Each wave swells and withdraws over 7–12 seconds.
    wavePhase += 1 / (waveSeconds * sampleRate)
    if wavePhase >= 1 {
      wavePhase = 0
      waveSeconds = 7 + 5 * (white() + 1) * 0.5
    }
    let swell = sin(.pi * wavePhase)
    let envelope = 0.18 + 0.82 * swell * swell
    return oceanTone.process(brownNoise()) * envelope * 0.9
  }

  private var noiseTone: OnePole
  private var crackleTone: OnePole
  private var crackleLevel: Float = 0

  /// A quiet fireplace: sparse, soft pops.
  private func crackle() -> Float {
    if chance(perSecond: 3) { crackleLevel = 0.1 + 0.3 * (white() + 1) * 0.5 }
    crackleLevel *= 0.9975
    return crackleTone.process(white()) * crackleLevel
  }

  // MARK: - Tuned voices (piano and music box)

  private struct Voice {
    var active = false
    var partials: (Float, Float, Float) = (1, 2, 3)
    var phases: (Float, Float, Float) = (0, 0, 0)
    var steps: (Float, Float, Float) = (0, 0, 0)
    var levels: (Float, Float, Float) = (0, 0, 0)
    var decays: (Float, Float, Float) = (0, 0, 0)
    var attack: Float = 0
  }

  private enum Timbre {
    /// Soft felt piano: warm harmonics, long fade.
    case piano
    /// Metal comb of a music box: bright, slightly bell-like partials, quicker fade.
    case musicBox
  }

  private static let voiceCount = 16
  private let voices: UnsafeMutablePointer<Voice>
  private var echoA: DelayLine
  private var echoB: DelayLine

  private func play(midi: Int, velocity: Float, timbre: Timbre) {
    // Reuse a free voice, or the quietest one.
    var slot = 0
    var quietest = Float.greatestFiniteMagnitude
    for index in 0..<Self.voiceCount {
      if !voices[index].active { slot = index; break }
      if voices[index].levels.0 < quietest {
        quietest = voices[index].levels.0
        slot = index
      }
    }
    let frequency = 440 * pow(2, Float(midi - 69) / 12)
    let (partials, amplitudes, seconds): ((Float, Float, Float), (Float, Float, Float), (Float, Float, Float)) =
      switch timbre {
      case .piano: ((1, 2, 3), (1, 0.4, 0.15), (3.2, 1.4, 0.7))
      case .musicBox: ((1, 3.01, 5.4), (1, 0.22, 0.1), (1.8, 0.5, 0.2))
      }
    let step = 2 * Float.pi * frequency / sampleRate
    voices[slot] = Voice(
      active: true,
      partials: partials,
      phases: (0, 0, 0),
      steps: (step * partials.0, step * partials.1, step * partials.2),
      levels: (amplitudes.0 * velocity, amplitudes.1 * velocity, amplitudes.2 * velocity),
      decays: (
        exp(-1 / (seconds.0 * sampleRate)),
        exp(-1 / (seconds.1 * sampleRate)),
        exp(-1 / (seconds.2 * sampleRate))),
      attack: 0)
  }

  private func voicesSample() -> Float {
    var sum: Float = 0
    let attackStep = 1 / (0.006 * sampleRate)
    for index in 0..<Self.voiceCount where voices[index].active {
      var voice = voices[index]
      voice.attack = min(1, voice.attack + attackStep)
      sum += (sin(voice.phases.0) * voice.levels.0 + sin(voice.phases.1) * voice.levels.1
        + sin(voice.phases.2) * voice.levels.2) * voice.attack
      voice.phases.0 = (voice.phases.0 + voice.steps.0).truncatingRemainder(dividingBy: 2 * .pi)
      voice.phases.1 = (voice.phases.1 + voice.steps.1).truncatingRemainder(dividingBy: 2 * .pi)
      voice.phases.2 = (voice.phases.2 + voice.steps.2).truncatingRemainder(dividingBy: 2 * .pi)
      voice.levels.0 *= voice.decays.0
      voice.levels.1 *= voice.decays.1
      voice.levels.2 *= voice.decays.2
      if voice.levels.0 < 0.0003 { voice.active = false }
      voices[index] = voice
    }
    return sum
  }

  /// Two echoes of different lengths stand in for the reverb of a room.
  private func withEcho(_ dry: Float) -> Float {
    dry + 0.3 * (echoA.process(dry) + echoB.process(dry))
  }

  // MARK: - Generative piano

  private var samplesToNextNote = 0
  private var samplesToNextBass = 0
  private var bassStep = 0
  /// C major pentatonic: any two notes sound fine together, so random still sounds calm.
  private static let pianoNotes = [60, 62, 64, 67, 69, 72, 74, 76, 79]
  private static let bassNotes = [48, 45, 41, 43]  // C, A, F, G

  private func tickPiano() {
    samplesToNextNote -= 1
    if samplesToNextNote <= 0 {
      let note = Self.pianoNotes[Int((white() + 1) * 0.5 * Float(Self.pianoNotes.count - 1) + 0.5)]
      play(midi: note, velocity: 0.2 + 0.2 * (white() + 1) * 0.5, timbre: .piano)
      if white() > 0.6 {
        play(midi: note - 5, velocity: 0.13, timbre: .piano)
      }
      samplesToNextNote = Int((0.8 + 1.6 * (white() + 1) * 0.5) * sampleRate)
    }
    samplesToNextBass -= 1
    if samplesToNextBass <= 0 {
      play(midi: Self.bassNotes[bassStep % Self.bassNotes.count], velocity: 0.22, timbre: .piano)
      bassStep += 1
      samplesToNextBass = Int(6.5 * sampleRate)
    }
  }

  // MARK: - Music box

  /// (MIDI note, length in eighths); a rest is note 0.
  private static let lullabies: [(Int, Int)] = [
    // Brahms, "Wiegenlied" (1868)
    (64, 1), (64, 1), (67, 4), (64, 1), (64, 1), (67, 4),
    (64, 1), (67, 1), (72, 2), (71, 3), (69, 1), (69, 2), (67, 2),
    (62, 1), (64, 1), (65, 2), (62, 2), (62, 1), (64, 1), (65, 4),
    (62, 1), (65, 1), (71, 1), (69, 1), (67, 2), (71, 2), (72, 4),
    (60, 1), (60, 1), (72, 4), (69, 1), (65, 1), (67, 4),
    (64, 1), (60, 1), (65, 1), (67, 1), (69, 2), (67, 4),
    (60, 1), (60, 1), (72, 4), (69, 1), (65, 1), (67, 4),
    (64, 1), (60, 1), (65, 1), (64, 1), (62, 1), (60, 5),
    (0, 6),
    // "Twinkle, Twinkle, Little Star" (traditional)
    (60, 2), (60, 2), (67, 2), (67, 2), (69, 2), (69, 2), (67, 4),
    (65, 2), (65, 2), (64, 2), (64, 2), (62, 2), (62, 2), (60, 4),
    (67, 2), (67, 2), (65, 2), (65, 2), (64, 2), (64, 2), (62, 4),
    (67, 2), (67, 2), (65, 2), (65, 2), (64, 2), (64, 2), (62, 4),
    (60, 2), (60, 2), (67, 2), (67, 2), (69, 2), (69, 2), (67, 4),
    (65, 2), (65, 2), (64, 2), (64, 2), (62, 2), (62, 2), (60, 4),
    (0, 6),
  ]
  private var melodyStep = 0
  private var samplesToNextMelodyNote = 0

  private func tickMusicBox() {
    samplesToNextMelodyNote -= 1
    guard samplesToNextMelodyNote <= 0 else { return }
    let (note, eighths) = Self.lullabies[melodyStep % Self.lullabies.count]
    melodyStep += 1
    if note > 0 {
      // An octave up, where a music box sings.
      play(midi: note + 12, velocity: 0.34, timbre: .musicBox)
    }
    samplesToNextMelodyNote = Int(Float(eighths) * 0.36 * sampleRate)
  }
}

/// y += a · (x − y): a gentle low-pass filter.
private struct OnePole {
  private let a: Float
  private var y: Float = 0

  init(cutoff: Float, sampleRate: Double) {
    a = 1 - exp(-2 * .pi * cutoff / Float(sampleRate))
  }

  mutating func process(_ x: Float) -> Float {
    y += a * (x - y)
    return y
  }
}

/// A feedback echo with a fixed buffer, allocated once.
private final class DelayLine {
  private let buffer: UnsafeMutablePointer<Float>
  private let length: Int
  private let feedback: Float
  private var index = 0

  init(seconds: Double, sampleRate: Double, feedback: Float) {
    length = max(1, Int(seconds * sampleRate))
    buffer = .allocate(capacity: length)
    buffer.initialize(repeating: 0, count: length)
    self.feedback = feedback
  }

  deinit { buffer.deallocate() }

  func process(_ x: Float) -> Float {
    let out = buffer[index]
    buffer[index] = x + out * feedback
    index = (index + 1) % length
    return out
  }
}
