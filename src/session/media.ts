import type { RTCRtpSender } from 'react-native-webrtc';

import type { CameraFacing, MotionSensitivity, Quality, Sensitivity, SoundVolume } from '../settings';
/**
 * Fixed TCP port for signaling, so a remembered IP address keeps working across restarts.
 * Development builds use their own port and Bonjour type, so a test build on the same Wi-Fi
 * can never find (or scan its way into) a real baby unit.
 */
export const MONITOR_PORT = __DEV__ ? 47301 : 47300;
export const SERVICE_TYPE = __DEV__ ? '_babymondev._tcp' : '_babymon._tcp';

const PRESETS: Record<Quality, { width: number; height: number; frameRate: number; maxBitrate: number }> = {
  '720p': { width: 1280, height: 720, frameRate: 30, maxBitrate: 3_000_000 },
  '1080p': { width: 1920, height: 1080, frameRate: 30, maxBitrate: 6_000_000 },
};

/** Fraction of the picture that has to change to count as motion. */
export const MOTION_THRESHOLDS: Record<MotionSensitivity, number> = {
  off: 0,
  low: 0.04,
  medium: 0.012,
  high: 0.004,
};

/** How many dB above the room's usual noise count as a sound worth waking the parents for. */
export const LOUDNESS_THRESHOLDS: Record<Sensitivity, number> = {
  off: 0,
  low: 22,
  medium: 16,
  high: 10,
};

/** Classifier confidence that counts as crying (Apple's `baby_crying` / `crying_sobbing`). */
export const CRY_CONFIDENCE = 0.5;

export const SOUND_VOLUMES: Record<SoundVolume, number> = {
  low: 0.35,
  medium: 0.6,
  high: 0.9,
};

export function videoConstraints(camera: CameraFacing, quality: Quality) {
  const { width, height, frameRate } = PRESETS[quality];
  return { facingMode: camera === 'back' ? 'environment' : 'user', width, height, frameRate };
}

/**
 * WebRTC caps video at ~2.5 Mbps by default, which blurs 1080p.
 * On a home Wi-Fi we can afford more, and a sharp picture beats smooth motion here.
 */
export async function tuneVideoSender(sender: RTCRtpSender, quality: Quality) {
  if (sender.track?.kind !== 'video') return;
  const params = sender.getParameters();
  const encoding = params.encodings[0];
  if (!encoding) return;
  encoding.maxBitrate = PRESETS[quality].maxBitrate;
  encoding.maxFramerate = PRESETS[quality].frameRate;
  params.degradationPreference = 'maintain-resolution';
  await sender.setParameters(params).catch(() => {});
}
