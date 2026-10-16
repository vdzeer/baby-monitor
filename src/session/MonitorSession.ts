import { AppState } from 'react-native';
import {
  MediaStream,
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';

import BabyNative, { type Battery, type NetworkState } from '../../modules/baby-native';
import { t } from '../i18n';
import { random } from '../secrets';
import { sanitizeMonitorSettings, type MonitorSettings } from '../settings';
import {
  CRY_CONFIDENCE,
  LOUDNESS_THRESHOLDS,
  MONITOR_PORT,
  MOTION_THRESHOLDS,
  SOUND_VOLUMES,
  tuneVideoSender,
  videoConstraints,
} from './media';
import { listen } from './listen';
import { parseSignal, Store, type SignalMessage } from './protocol';
import type { MonitorCredentials } from './secure/credentials';
import { MonitorEndpoint, newDeviceId, PairingLimiter, PROTOCOL_VERSION, type MonitorEvent } from './secure/handshake';

export type MonitorState = {
  stream: MediaStream | null;
  /** Parent devices currently connected. */
  viewers: number;
  error: 'camera' | 'local-network' | null;
  /** When the sleep sound's timer turns it off (ms since epoch). */
  soundEndsAt: number | null;
  /** The code shown on screen; parents need it only to pair. */
  pairingCode: string;
  /** When a parent device with another version of Moonbeam last tried to connect (ms since epoch). */
  outdatedParentAt: number | null;
  /** That parent's version is newer than this one (this device needs the update). */
  parentNewer: boolean;
};

// Parents get at most one motion (or sound) alert per this interval, however long it goes on.
const ALERT_COOLDOWN_MS = 30_000;
// Connections that haven't authenticated: long enough to type the code, and only a few at a time
// (a new one pushes out the oldest), so strangers can't hold the baby unit's attention.
const HANDSHAKE_TIMEOUT_MS = 120_000;
const MAX_PENDING = 8;
const MAX_PENDING_PER_HOST = 3;
// A refusal (wrong code, too many attempts, other version) gets a moment to arrive before closing.
const REFUSAL_CLOSE_MS = 1_000;

/** A connection still in the handshake: nothing it sends is acted on except the handshake itself. */
type Pending = {
  endpoint: MonitorEndpoint;
  host: string;
  timer: ReturnType<typeof setTimeout>;
};

type Viewer = {
  pc: RTCPeerConnection;
  /** The authenticated, encrypted channel to this parent. */
  endpoint: MonitorEndpoint;
  /** Signaling steps must run in order: an ICE candidate can't be added before the answer. */
  queue: Promise<void>;
};

/**
 * The device next to the baby: captures camera + mic, advertises itself on the
 * Wi-Fi and streams to every parent device that connects (one peer connection each).
 */
export class MonitorSession extends Store<MonitorState> {
  private viewers = new Map<string, Viewer>();
  private subscriptions: { remove(): void }[] = [];
  private stopped = false;
  private serverRetry: ReturnType<typeof setTimeout> | undefined;
  private lastMotionAt = 0;
  private lastSoundAt = 0;
  private lastCryAt = 0;
  private battery: Battery = { level: -1, charging: false };
  private soundTimer: ReturnType<typeof setTimeout> | undefined;
  /** Incoming connections that haven't authenticated yet, oldest first. */
  private pending = new Map<string, Pending>();
  /** Limits on attempts with the code; parents with a pairing key never touch it. */
  private limiter = new PairingLimiter();

  constructor(
    private settings: MonitorSettings,
    private monitorId: string,
    private credentials: MonitorCredentials,
    private onSettingsChange: (patch: Partial<MonitorSettings>) => void,
  ) {
    super({
      stream: null,
      viewers: 0,
      error: null,
      soundEndsAt: null,
      pairingCode: credentials.code,
      outdatedParentAt: null,
      parentNewer: false,
    });
  }

  async start() {
    this.stopped = false;
    this.subscriptions = [
      AppState.addEventListener('change', () => this.broadcastStatus()),
      BabyNative.addListener('onServerState', (event) => this.onServerState(event)),
      BabyNative.addListener('onPeerOpen', ({ peerId, incoming, host }) => incoming && this.accept(peerId, host ?? '')),
      BabyNative.addListener('onPeerMessage', ({ peerId, message }) => this.onMessage(peerId, message)),
      BabyNative.addListener('onPeerClose', ({ peerId }) => {
        this.forget(peerId);
        this.removeViewer(peerId);
      }),
      BabyNative.addListener('onMotion', () => this.onMotion()),
      BabyNative.addListener('onLoudSound', () => this.onLoudSound()),
      BabyNative.addListener('onCry', () => this.onCry()),
      BabyNative.addListener('onBatteryChange', (battery) => {
        this.battery = battery;
        this.broadcastBattery();
      }),
    ];
    this.battery = BabyNative.getBattery();
    // A sleep sound doesn't come back by itself after a restart (at 3 a.m. that would wake the baby).
    if (this.settings.sound !== 'off') {
      this.settings = { ...this.settings, sound: 'off' };
      this.onSettingsChange({ sound: 'off' });
    }

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: videoConstraints(this.settings.camera, this.settings.quality),
      });
      if (this.stopped) {
        stream.release();
        return;
      }
      // Every camera frame goes through the motion detector, then night mode (MotionDetector.swift,
      // NightVision.swift): motion is judged on the untouched picture.
      stream.getVideoTracks()[0]?._setVideoEffects(['babyMotion', 'babyNight']);
      BabyNative.setNightMode(this.settings.night);
      BabyNative.setMotionThreshold(MOTION_THRESHOLDS[this.settings.motion]);
      BabyNative.setLoudSoundThreshold(LOUDNESS_THRESHOLDS[this.settings.loudness]);
      BabyNative.setCryThreshold(this.settings.cry === 'on' ? CRY_CONFIDENCE : 0);
      this.setState({ stream, error: null });
    } catch {
      this.setState({ error: 'camera' });
      return;
    }

    // Only advertise once there is something to show.
    BabyNative.startServer(this.serviceName, MONITOR_PORT);
  }

  /** Each baby unit advertises its own name, so parents never mistake one for another. */
  private get serviceName() {
    return `${t.serviceName} ${this.monitorId.slice(-4)}`.trim();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.serverRetry);
    this.subscriptions.forEach((subscription) => subscription.remove());
    BabyNative.stopServer();
    BabyNative.setMotionThreshold(0);
    BabyNative.setLoudSoundThreshold(0);
    BabyNative.setCryThreshold(0);
    BabyNative.stopSleepSound();
    clearTimeout(this.soundTimer);
    this.viewers.forEach(({ pc }) => pc.close());
    this.viewers.clear();
    this.pending.forEach(({ timer }) => clearTimeout(timer));
    this.pending.clear();
    this.state.stream?.release();
    this.setState({ stream: null, viewers: 0, soundEndsAt: null });
  }

  /**
   * Applies a change from this device's menu or from a parent, on the fly and without
   * reconnecting anyone, then saves it and shows it to every parent.
   */
  async updateSettings(patch: Partial<MonitorSettings>) {
    const previous = this.settings;
    const settings = { ...previous, ...patch };
    this.settings = settings;
    this.onSettingsChange(patch);
    this.applySound(previous, settings);
    this.broadcastSettings();

    BabyNative.setMotionThreshold(MOTION_THRESHOLDS[settings.motion]);
    BabyNative.setLoudSoundThreshold(LOUDNESS_THRESHOLDS[settings.loudness]);
    BabyNative.setCryThreshold(settings.cry === 'on' ? CRY_CONFIDENCE : 0);
    BabyNative.setNightMode(settings.night);
    if (settings.camera === previous.camera && settings.quality === previous.quality) return;
    const video = this.state.stream?.getVideoTracks()[0];
    if (!video) return;
    await video.applyConstraints(videoConstraints(settings.camera, settings.quality)).catch(() => {});
    for (const { pc } of this.viewers.values()) {
      for (const sender of pc.getSenders()) await tuneVideoSender(sender, settings.quality);
    }
  }

  /**
   * A new code: the baby unit forgets every parent's pairing key, so each has to pair again with the
   * new code. False if the Keychain didn't take it; then nothing changed.
   */
  setPairingCode(code: string): boolean {
    if (!this.credentials.setCode(code, newDeviceId(random))) return false;
    this.limiter.reset();
    this.setState({ pairingCode: code });
    // Forget every connection now, not when native reports it closed: a message already on its way
    // from one of them must find nothing to finish (a pairing under the old code, a settings change).
    const peers = [...this.viewers.keys(), ...this.pending.keys()];
    peers.forEach((peerId) => {
      this.forget(peerId);
      this.removeViewer(peerId);
      BabyNative.closePeer(peerId);
    });
    return true;
  }

  private applySound(previous: MonitorSettings, settings: MonitorSettings) {
    const volume = SOUND_VOLUMES[settings.soundVolume];
    if (settings.sound === 'off') {
      if (previous.sound !== 'off') BabyNative.stopSleepSound();
      clearTimeout(this.soundTimer);
      this.setState({ soundEndsAt: null });
      return;
    }
    if (settings.sound !== previous.sound) {
      BabyNative.playSleepSound(settings.sound, volume);
    } else if (settings.soundVolume !== previous.soundVolume) {
      BabyNative.setSleepSoundVolume(volume);
    }
    // Starting a sound or picking another timer starts the countdown afresh.
    if (previous.sound === 'off' || settings.soundTimer !== previous.soundTimer) {
      clearTimeout(this.soundTimer);
      const minutes = settings.soundTimer === 'never' ? 0 : Number(settings.soundTimer);
      this.setState({ soundEndsAt: minutes ? Date.now() + minutes * 60_000 : null });
      if (minutes) this.soundTimer = setTimeout(() => void this.updateSettings({ sound: 'off' }), minutes * 60_000);
    }
  }

  /**
   * Encrypted for this parent's channel; parents that haven't authenticated get nothing, and neither
   * does one whose channel just failed (closing it takes a moment).
   */
  private send(peerId: string, message: SignalMessage) {
    const viewer = this.viewers.get(peerId);
    if (viewer?.endpoint.isOpen) BabyNative.send(peerId, viewer.endpoint.seal(JSON.stringify(message)));
  }

  private broadcast(message: SignalMessage) {
    this.viewers.forEach((_, peerId) => this.send(peerId, message));
  }

  private broadcastSettings() {
    this.broadcast({ type: 'settings', settings: this.settings, soundEndsAt: this.state.soundEndsAt });
  }

  private onMotion() {
    const now = Date.now();
    if (now - this.lastMotionAt < ALERT_COOLDOWN_MS) return;
    this.lastMotionAt = now;
    this.broadcast({ type: 'motion' });
  }

  private onLoudSound() {
    const now = Date.now();
    if (now - this.lastSoundAt < ALERT_COOLDOWN_MS) return;
    this.lastSoundAt = now;
    this.broadcast({ type: 'sound' });
  }

  private onCry() {
    const now = Date.now();
    if (now - this.lastCryAt < ALERT_COOLDOWN_MS) return;
    this.lastCryAt = now;
    this.broadcast({ type: 'cry' });
  }

  private broadcastBattery() {
    this.broadcast({ type: 'battery', ...this.battery });
  }

  private broadcastDevices() {
    const { pairedCount, pairings, generation } = this.credentials;
    this.broadcast({ type: 'devices', paired: pairedCount, watching: this.viewers.size, pairings, generation });
  }

  private onServerState({ state, denied }: NetworkState) {
    if (state === 'ready') {
      if (this.state.error === 'local-network') this.setState({ error: null });
    } else if (denied) {
      this.setState({ error: 'local-network' });
    }
    // A failed listener (e.g. after a network change) does not recover on its own.
    if (state === 'failed' && !this.stopped) {
      clearTimeout(this.serverRetry);
      this.serverRetry = setTimeout(() => BabyNative.startServer(this.serviceName, MONITOR_PORT), 2000);
    }
  }

  /** A new incoming connection: say who we are and wait for the parent to authenticate or pair. */
  private accept(peerId: string, host: string) {
    if (this.stopped) {
      BabyNative.closePeer(peerId);
      return;
    }
    const fromHost = [...this.pending.entries()].filter(([, pending]) => pending.host === host);
    if (fromHost.length >= MAX_PENDING_PER_HOST) this.drop(fromHost[0][0]);
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.drop(oldest);
    }
    const endpoint = new MonitorEndpoint({
      random,
      monitorId: this.monitorId,
      host,
      send: (line) => BabyNative.send(peerId, line),
      code: () => this.credentials.code,
      parentKey: (parentId) => this.credentials.parentKey(parentId),
      limiter: this.limiter,
    });
    const timer = setTimeout(() => BabyNative.closePeer(peerId), HANDSHAKE_TIMEOUT_MS);
    this.pending.set(peerId, { endpoint, host, timer });
    endpoint.welcome();
  }

  /** Stops tracking a connection's handshake (it finished, failed or closed). */
  private forget(peerId: string) {
    const pending = this.pending.get(peerId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(peerId);
  }

  private onHandshake(peerId: string, endpoint: MonitorEndpoint, event: MonitorEvent) {
    switch (event.kind) {
      case 'paired':
        this.credentials.saveParentKey(event.parentId, event.pairingKey);
        this.forget(peerId);
        this.addViewer(peerId, endpoint);
        break;
      case 'open':
        this.forget(peerId);
        this.addViewer(peerId, endpoint);
        break;
      case 'outdated':
        this.setState({ outdatedParentAt: Date.now(), parentNewer: event.peerVersion > PROTOCOL_VERSION });
        this.refuse(peerId);
        break;
      case 'limited':
      case 'error':
      case 'message':
        this.refuse(peerId);
        break;
    }
  }

  private drop(peerId: string) {
    this.forget(peerId);
    BabyNative.closePeer(peerId);
  }

  private refuse(peerId: string) {
    this.forget(peerId);
    setTimeout(() => BabyNative.closePeer(peerId), REFUSAL_CLOSE_MS);
  }

  private addViewer(peerId: string, endpoint: MonitorEndpoint) {
    const stream = this.state.stream;
    if (!stream || this.stopped) {
      BabyNative.closePeer(peerId);
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: [] });
    const viewer: Viewer = { pc, endpoint, queue: Promise.resolve() };
    this.viewers.set(peerId, viewer);
    this.setState({ viewers: this.viewers.size });

    // Send-only: parents watch and listen, they never play anything into the nursery. A parent's
    // answer can't turn this into a receiving connection (addTrack would offer send and receive).
    stream.getTracks().forEach((track) => pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] }));
    listen(pc, 'icecandidate', ({ candidate }) => {
      if (candidate) this.send(peerId, { type: 'candidate', candidate: candidate.toJSON() });
    });
    listen(pc, 'connectionstatechange', () => {
      // The parent device reconnects by itself; just drop the broken connection.
      if (pc.connectionState === 'failed') BabyNative.closePeer(peerId);
    });

    this.send(peerId, { type: 'hello', addresses: BabyNative.getLocalAddresses() });
    this.send(peerId, { type: 'status', video: AppState.currentState !== 'background' });
    this.send(peerId, { type: 'settings', settings: this.settings, soundEndsAt: this.state.soundEndsAt });
    this.send(peerId, { type: 'battery', ...this.battery });
    this.broadcastDevices();
    this.enqueue(peerId, viewer, async () => {
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      this.send(peerId, { type: 'offer', sdp: offer.sdp });
      for (const sender of pc.getSenders()) await tuneVideoSender(sender, this.settings.quality);
    });
  }

  private onMessage(peerId: string, raw: string) {
    const pending = this.pending.get(peerId);
    if (pending) {
      for (const event of pending.endpoint.receive(raw)) this.onHandshake(peerId, pending.endpoint, event);
      return;
    }
    const viewer = this.viewers.get(peerId);
    if (!viewer) return;
    for (const event of viewer.endpoint.receive(raw)) {
      // Anything that doesn't decrypt (altered, replayed, or not from this parent) ends the connection.
      if (event.kind !== 'message') {
        this.removeViewer(peerId);
        BabyNative.closePeer(peerId);
        return;
      }
      this.onSignal(peerId, viewer, event.text);
    }
  }

  /** A message from an authenticated parent. */
  private onSignal(peerId: string, viewer: Viewer, text: string) {
    const message = parseSignal(text);
    if (message?.type === 'setSettings') {
      const patch = sanitizeMonitorSettings(message.settings);
      if (Object.keys(patch).length > 0) void this.updateSettings(patch);
    } else if (message?.type === 'answer' && typeof message.sdp === 'string') {
      this.enqueue(peerId, viewer, () =>
        viewer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: message.sdp })),
      );
    } else if (message?.type === 'candidate') {
      this.enqueue(peerId, viewer, () => viewer.pc.addIceCandidate(new RTCIceCandidate(message.candidate)));
    }
  }

  /** Audio keeps streaming from the background, video doesn't: tell the parents which it is. */
  private broadcastStatus() {
    this.broadcast({ type: 'status', video: AppState.currentState !== 'background' });
  }

  private enqueue(peerId: string, viewer: Viewer, step: () => Promise<void>) {
    viewer.queue = viewer.queue.then(step).catch(() => BabyNative.closePeer(peerId));
  }

  private removeViewer(peerId: string) {
    const viewer = this.viewers.get(peerId);
    if (!viewer) return;
    viewer.pc.close();
    this.viewers.delete(peerId);
    this.setState({ viewers: this.viewers.size });
    this.broadcastDevices();
  }
}
