import AsyncStorage from '@react-native-async-storage/async-storage';


export type Role = 'monitor' | 'parent';
export type CameraFacing = 'back' | 'front';
export type Quality = '720p' | '1080p';
export type Sensitivity = 'off' | 'low' | 'medium' | 'high';
export type MotionSensitivity = Sensitivity;
/** Synthesized on the baby unit, see SleepSynth.swift. */
export type SleepSound = 'off' | 'rainPiano' | 'lullaby' | 'rain' | 'ocean' | 'noise';
export type SoundVolume = 'low' | 'medium' | 'high';
export type SoundTimer = 'never' | '15' | '30' | '60';
/** Baby unit camera in the dark: 'auto' brightens only when the room is dark. */
export type NightMode = 'off' | 'auto' | 'on';

export type Settings = {
  role: Role | null;
  camera: CameraFacing;
  quality: Quality;
  night: NightMode;
  /** Baby unit: how little movement is enough to alert the parents. */
  motion: MotionSensitivity;
  /** Baby unit: how loud (above the room's usual noise) a sound must be to alert the parents. */
  loudness: Sensitivity;
  /** Baby unit: tell crying apart from other sounds with Apple's sound classifier. */
  cry: 'off' | 'on';
  /** Baby unit: the sleep sound playing now. */
  sound: SleepSound;
  soundVolume: SoundVolume;
  /** Minutes until the sleep sound fades out by itself. */
  soundTimer: SoundTimer;
  /** Parent unit: show notifications when the baby unit reports motion. */
  motionAlerts: boolean;
  /** Parent unit: show notifications when the baby unit hears a loud sound or crying. */
  soundAlerts: boolean;
  /**
   * Parent unit, when the app goes to the background: the video in a Picture in Picture window,
   * or the status in the Dynamic Island and on the lock screen (a Live Activity).
   */
  whenMinimized: 'pip' | 'island';
  /** Bonjour name of the monitor this parent device watched last time. */
  lastMonitor: string | null;
  /** IP addresses of that monitor, for reconnecting without Bonjour (e.g. from another subnet). */
  monitorAddresses: string[];
  /** Baby unit: stable identity parents remember their pairing under. Not secret. */
  monitorId: string | null;
  /**
   * Parent: how many devices each baby unit (by id) had paired when this one last saw it, to notice
   * a device that paired since.
   */
  pairedDevices: Record<string, { generation: string; pairings: number }>;
  // The pairing code and pairing keys are secrets and live in the Keychain (src/secrets.ts).
};

/** What a baby unit can be told to change, from its own menu or from a parent device. */
export type MonitorSettings = Pick<
  Settings,
  'camera' | 'quality' | 'night' | 'motion' | 'loudness' | 'cry' | 'sound' | 'soundVolume' | 'soundTimer'
>;

export function pickMonitorSettings(settings: Settings): MonitorSettings {
  const { camera, quality, night, motion, loudness, cry, sound, soundVolume, soundTimer } = settings;
  return { camera, quality, night, motion, loudness, cry, sound, soundVolume, soundTimer };
}

const MONITOR_SETTING_VALUES: { [K in keyof MonitorSettings]: readonly MonitorSettings[K][] } = {
  camera: ['back', 'front'],
  quality: ['720p', '1080p'],
  night: ['off', 'auto', 'on'],
  motion: ['off', 'low', 'medium', 'high'],
  loudness: ['off', 'low', 'medium', 'high'],
  cry: ['off', 'on'],
  sound: ['off', 'rainPiano', 'lullaby', 'rain', 'ocean', 'noise'],
  soundVolume: ['low', 'medium', 'high'],
  soundTimer: ['never', '15', '30', '60'],
};

/**
 * A baby unit's full settings as reported to a parent, or null unless every one of them has a known
 * value (the parent renders and does arithmetic with them).
 */
export function completeMonitorSettings(input: unknown): MonitorSettings | null {
  const settings = sanitizeMonitorSettings(input);
  return Object.keys(settings).length === Object.keys(MONITOR_SETTING_VALUES).length
    ? (settings as MonitorSettings)
    : null;
}

/**
 * A settings change that arrived over the network: keeps only baby unit settings with known
 * values, so a parent can't overwrite other keys (role, monitor id) or save a value that breaks
 * the camera on the next start.
 */
export function sanitizeMonitorSettings(input: unknown): Partial<MonitorSettings> {
  if (typeof input !== 'object' || input === null) return {};
  const patch: Record<string, unknown> = {};
  for (const [key, allowed] of Object.entries(MONITOR_SETTING_VALUES) as [string, readonly unknown[]][]) {
    const value = (input as Record<string, unknown>)[key];
    if (allowed.includes(value)) patch[key] = value;
  }
  return patch as Partial<MonitorSettings>;
}

export const DEFAULT_SETTINGS: Settings = {
  role: null,
  camera: 'back',
  quality: '1080p',
  night: 'auto',
  motion: 'medium',
  loudness: 'medium',
  cry: 'on',
  sound: 'off',
  soundVolume: 'medium',
  soundTimer: '30',
  motionAlerts: true,
  soundAlerts: true,
  whenMinimized: 'pip',
  lastMonitor: null,
  monitorAddresses: [],
  monitorId: null,
  pairedDevices: {},
};

const STORAGE_KEY = 'settings.v1';

/**
 * The saved settings. `fresh`: nothing saved yet, so this is a new installation (iOS deletes this
 * storage with the app, but not the Keychain). `hadV1Secrets`: version 1 kept pairing codes here;
 * they are never used again (see src/session/secure/credentials.ts), and the next `saveSettings`
 * writes the settings without them.
 */
export async function loadSettings(): Promise<{ settings: Settings; fresh: boolean; hadV1Secrets: boolean }> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { settings: DEFAULT_SETTINGS, fresh: true, hadV1Secrets: false };
    const { pairingCode, pairedMonitors, ...saved } = JSON.parse(raw);
    const hadV1Secrets = pairingCode !== undefined || pairedMonitors !== undefined;
    return { settings: { ...DEFAULT_SETTINGS, ...saved }, fresh: false, hadV1Secrets };
  } catch {
    return { settings: DEFAULT_SETTINGS, fresh: false, hadV1Secrets: false };
  }
}

export function saveSettings(settings: Settings) {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings)).catch(() => {});
}
