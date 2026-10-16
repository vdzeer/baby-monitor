import { NativeModule, requireNativeModule } from 'expo';

import { Battery, BabyNativeModuleEvents, LiveActivityState } from './BabyNative.types';

declare class BabyNativeModule extends NativeModule<BabyNativeModuleEvents> {
  /**
   * Moves the on-screen WebRTC video into Picture in Picture, or back if it's already there.
   * Resolves with 'started' | 'stopped', or why iOS refused: 'not-possible' | 'unsupported' | 'no-video' | …
   */
  togglePictureInPicture(): Promise<string>;
  /** Whether leaving the app turns the on-screen video into Picture in Picture by itself. */
  setAutoPictureInPicture(enabled: boolean): void;
  /** Hide the home indicator and defer edge swipes (monitor's black screen). */
  setImmersive(enabled: boolean): void;

  /** Cryptographically random decimal digits. */
  randomDigits(count: number): string;

  /** Sleep sound on this device's speaker: 'rainPiano' | 'lullaby' | 'rain' | 'ocean' | 'noise'. */
  playSleepSound(kind: string, volume: number): void;
  setSleepSoundVolume(volume: number): void;
  /** Fades the sleep sound out. */
  stopSleepSound(): void;
  /** Confidence (0...1) at which Apple's classifier counts as a baby crying; 0 turns it off. */
  setCryThreshold(confidence: number): void;
  /** This device's battery; also starts onBatteryChange events. */
  getBattery(): Battery;
  /** Whether this device shows Live Activities (iPhone, iOS 16.2+, allowed in Settings; not iPad). */
  areLiveActivitiesEnabled(): boolean;
  /** Starts (in the foreground) or updates the parent's lock-screen status. */
  updateLiveActivity(monitorName: string, state: LiveActivityState): void;
  endLiveActivity(): void;
  /** Night mode for tracks with the "babyNight" video effect: 'off' | 'auto' | 'on'. */
  setNightMode(mode: string): void;
  /** dB above the room's usual noise that counts as a loud sound; 0 turns it off. */
  setLoudSoundThreshold(decibels: number): void;

  /**
   * Motion detection on camera frames of tracks that enabled the "babyMotion" video effect.
   * `threshold` is the fraction of the picture that must change; 0 turns it off.
   */
  setMotionThreshold(threshold: number): void;

  /** Bonjour service type for everything below (development builds use their own). */
  setServiceType(type: string): void;

  /** Advertise this device over Bonjour and accept parent connections on a fixed TCP port. */
  startServer(name: string, port: number): void;
  stopServer(): void;

  /** Look for monitors on the local network; results arrive via onServicesChanged. */
  startBrowsing(): void;
  stopBrowsing(): void;

  /** Open a connection to a monitor by its Bonjour name. Returns the peer id. */
  connect(serviceName: string): string;
  /** Open a connection to a monitor by IP address, bypassing Bonjour. Returns the peer id. */
  connectAddress(host: string, port: number): string;
  /** This device's IPv4 addresses on Wi-Fi / Ethernet. */
  getLocalAddresses(): string[];
  /** Probe this device's /24 subnet for hosts accepting TCP on `port` (for when Bonjour sees nothing). */
  scanSubnet(port: number): Promise<string[]>;
  send(peerId: string, message: string): void;
  closePeer(peerId: string): void;
}

export default requireNativeModule<BabyNativeModule>('BabyNative');
