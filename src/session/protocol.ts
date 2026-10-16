import type { MonitorSettings } from '../settings';

/**
 * App messages between a baby unit and a parent device. They travel only inside the encrypted,
 * authenticated channel that the handshake in `secure/handshake.ts` sets up, so each one comes from
 * a paired device and nobody on the network can read, change or replay it. That includes the SDP
 * with its DTLS fingerprints, which binds the WebRTC media encryption to the pairing too.
 */
export type SignalMessage =
  /** Monitor → parent right after connecting: where to find the monitor next time without Bonjour. */
  | { type: 'hello'; addresses: string[] }
  /** Monitor → parent: iOS pauses the camera while the monitor app is in the background or locked. */
  | { type: 'status'; video: boolean }
  /** Monitor → parent: the camera saw movement. */
  | { type: 'motion' }
  /** Monitor → parent: its microphone heard a loud sound. */
  | { type: 'sound' }
  /** Monitor → parent: Apple's sound classifier heard a baby crying. */
  | { type: 'cry' }
  /** Monitor → parents: its battery, on connect and whenever it changes (`level` 0...1, -1 unknown). */
  | { type: 'battery'; level: number; charging: boolean }
  /**
   * Monitor → parents: its current settings, on connect and after every change, and when
   * the sleep sound's timer will turn it off (ms since epoch).
   */
  | { type: 'settings'; settings: MonitorSettings; soundEndsAt: number | null }
  /**
   * Monitor → parents: how many parent devices are paired with it and how many watch right now, on
   * connect and whenever either changes, so a device nobody in the family knows about shows up.
   * `pairings` counts every pairing with the current code (`generation`), including ones that
   * replaced a key, so parents notice those too.
   */
  | { type: 'devices'; paired: number; watching: number; pairings: number; generation: string }
  /** Parent → monitor: change some settings. */
  | { type: 'setSettings'; settings: Partial<MonitorSettings> }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } };

export function parseSignal(raw: string): SignalMessage | null {
  try {
    const message = JSON.parse(raw);
    return typeof message?.type === 'string' ? message : null;
  } catch {
    return null;
  }
}

/** Minimal observable store so React can read session state via useSyncExternalStore. */
export class Store<T extends object> {
  private listeners = new Set<() => void>();

  constructor(protected state: T) {}

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  protected setState(patch: Partial<T>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
