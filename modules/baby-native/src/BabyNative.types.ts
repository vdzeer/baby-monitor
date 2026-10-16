export type NetworkState = {
  state: 'setup' | 'ready' | 'waiting' | 'failed' | 'cancelled';
  error?: string;
  /** The user has not allowed Local Network access in iOS Settings. */
  denied: boolean;
};

export type BabyNativeModuleEvents = {
  onServerState: (event: NetworkState) => void;
  onBrowserState: (event: NetworkState) => void;
  onServicesChanged: (event: { services: string[] }) => void;
  /** `host`: the peer's IP address, for the baby unit's per-address pairing backoff ("" if unknown). */
  onPeerOpen: (event: { peerId: string; incoming: boolean; host: string }) => void;
  onPeerMessage: (event: { peerId: string; message: string }) => void;
  onPeerClose: (event: { peerId: string }) => void;
  /** Baby unit camera saw movement; `level` is the fraction of the picture that changed. */
  onMotion: (event: { level: number }) => void;
  /** Baby unit microphone heard a sustained sound well above the room's usual noise. */
  onLoudSound: (event: Record<string, never>) => void;
  /** Baby unit: Apple's sound classifier heard a baby crying. */
  onCry: (event: Record<string, never>) => void;
  /** Parent: how loud the baby unit's sound is right now, 0...1, about eight times a second. */
  onPlayoutLevel: (event: { level: number }) => void;
  onBatteryChange: (event: Battery) => void;
};

/** `level` is 0...1, or -1 when iOS doesn't know. */
export type Battery = { level: number; charging: boolean };

/** Lock-screen status; texts arrive already translated. */
export type LiveActivityState = {
  status: 'live' | 'warning' | 'offline';
  title: string;
  detail?: string | null;
  sound?: string | null;
  battery?: number | null;
  charging: boolean;
};
