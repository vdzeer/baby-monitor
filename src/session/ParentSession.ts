import {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';

import BabyNative, { type Battery } from '../../modules/baby-native';
import { random } from '../secrets';
import { completeMonitorSettings, type MonitorSettings, type Settings } from '../settings';
import { listen } from './listen';
import { MONITOR_PORT } from './media';
import { parseSignal, Store, type SignalMessage } from './protocol';
import { nextParentStep, type ParentCredentials } from './secure/credentials';
import { ParentEndpoint, PROTOCOL_VERSION, type ParentEvent } from './secure/handshake';

export type ParentPhase =
  | 'searching' // no monitor found yet
  | 'choosing' // several monitors and none remembered: the user picks one
  | 'connecting'
  | 'live'
  | 'reconnecting'; // lost the monitor; the last picture stays on screen while retrying

export type ParentState = {
  phase: ParentPhase;
  /** What to render. While reconnecting it's the last (frozen) stream. */
  stream: MediaStream | null;
  monitors: string[];
  monitor: string | null;
  localNetworkDenied: boolean;
  /** The monitor app is in the background or locked: sound still streams, the picture is frozen. */
  videoPaused: boolean;
  /** When the baby unit last reported movement (ms since epoch). */
  lastMotionAt: number | null;
  /** When the baby unit last heard a loud sound (ms since epoch). */
  lastSoundAt: number | null;
  /** When the baby unit last heard crying (ms since epoch). */
  lastCryAt: number | null;
  /** When the last new video frame was decoded here (ms since epoch): a frozen picture shows up as an old time. */
  lastFrameAt: number | null;
  monitorBattery: Battery | null;
  /** When the baby unit's sleep sound turns itself off (ms since epoch). */
  monitorSoundEndsAt: number | null;
  /** The connected baby unit's settings, which parents can change remotely. */
  monitorSettings: MonitorSettings | null;
  /**
   * A baby unit asks for its pairing code before it streams. `retryAt`: it refuses codes until
   * then (ms since epoch) after too many wrong ones.
   */
  pairing: { monitor: string; checking: boolean; wrongCode: boolean; retryAt: number | null } | null;
  /** The baby unit runs another version of Moonbeam: 'monitor' if it is older, 'parent' if this device is. */
  outdated: 'monitor' | 'parent' | null;
  /** Parent devices paired with the connected baby unit, and how many of them watch now. */
  monitorDevices: { paired: number; watching: number } | null;
  /** When a device paired with the baby unit since this one last saw it (ms since epoch). */
  newDeviceAt: number | null;
};

type Remembered = Pick<Settings, 'lastMonitor' | 'monitorAddresses' | 'pairedDevices'>;

/** Bonjour name when the monitor is visible on this network, IP address otherwise. */
type Target = { kind: 'bonjour'; name: string } | { kind: 'address'; host: string };

type Connection = {
  peerId: string;
  target: Target;
  /** The user picked this baby unit, as opposed to automatic discovery. */
  explicit: boolean;
  /** Handshake and, once authenticated, the encrypted channel to the baby unit. */
  endpoint: ParentEndpoint;
  /** From the baby unit's welcome. */
  monitorId?: string;
  /** The baby unit answered our stored key with `pairRequired`. */
  keyRejected: boolean;
  /** This device paired on this connection: the next device count includes it. */
  justPaired: boolean;
  /** Whatever answered proved it is a baby unit we're paired with. */
  authenticated: boolean;
  /** The TCP connection opened, so something listens there. */
  opened: boolean;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  video: boolean;
  queue: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

const CONNECT_TIMEOUT_MS = 6_000;
// ICE reports "disconnected" on short hiccups and sometimes recovers by itself.
const DISCONNECT_GRACE_MS = 2_000;
const RETRY_MS = 1_000;
// Pause between subnet scans while no monitor answers anywhere.
const SCAN_INTERVAL_MS = 5_000;
// A baby unit with another version of Moonbeam won't connect until one side is updated: ask less often.
const OUTDATED_RETRY_MS = 10_000;
// Automatic discovery skips a baby unit that isn't ours for this long, then looks again: whatever
// answered may have been posing as one.
const FOREIGN_MS = 60_000;
// Something that accepted the connection but didn't prove itself is skipped this long, so the other
// names, addresses and scan results get their turn (it may be holding our baby unit's name).
const SKIP_MS = 5_000;
const MAX_ADDRESSES = 8;
const GENERATION = /^[0-9a-f]{16,64}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * A parent device: finds the monitor, connects, and keeps reconnecting forever if the link drops.
 */
export class ParentSession extends Store<ParentState> {
  private conn: Connection | null = null;
  /**
   * The connection whose media is playing. It is closed only after a replacement is live
   * ("make before break"): an open receiving connection keeps the audio unit running,
   * and background audio is what keeps iOS from suspending the app mid-reconnect.
   */
  private livePc: RTCPeerConnection | null = null;
  private subscriptions: { remove(): void }[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private browseRetry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Monitor to connect to when Bonjour sees it; starts as the remembered one. */
  private preferred: string | null;
  private addressTurn = 0;
  private scanning = false;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private framesSeen = { pc: null as RTCPeerConnection | null, count: 0 };
  /** A code the user just typed, not confirmed by the baby unit yet. */
  private pendingCode: string | null = null;
  /**
   * Baby units that aren't ours (or that the user declined), by target, and until when automatic
   * discovery skips them.
   */
  private foreign = new Map<string, number>();
  /** Our baby units that don't take our key or code any more: ask for the code instead of skipping them. */
  private repairing = new Set<string>();
  /** Hosts from the last subnet scan not tried yet. */
  private scanQueue: string[] = [];

  constructor(
    private remembered: Remembered,
    private credentials: ParentCredentials,
    private onRemember: (patch: Partial<Remembered>) => void,
  ) {
    super({
      phase: 'searching',
      stream: null,
      monitors: [],
      monitor: null,
      localNetworkDenied: false,
      videoPaused: false,
      lastMotionAt: null,
      lastSoundAt: null,
      lastCryAt: null,
      lastFrameAt: null,
      monitorBattery: null,
      monitorSoundEndsAt: null,
      monitorSettings: null,
      pairing: null,
      outdated: null,
      monitorDevices: null,
      newDeviceAt: null,
    });
    this.preferred = remembered.lastMonitor;
  }

  start() {
    this.stopped = false;
    this.subscriptions = [
      BabyNative.addListener('onServicesChanged', ({ services }) => {
        this.setState({ monitors: services });
        if (!this.conn && !this.retryTimer) this.tryConnect();
      }),
      BabyNative.addListener('onBrowserState', ({ state, denied }) => {
        this.setState({ localNetworkDenied: denied });
        if (state === 'failed' && !this.stopped) {
          clearTimeout(this.browseRetry);
          this.browseRetry = setTimeout(() => BabyNative.startBrowsing(), 2000);
        }
      }),
      BabyNative.addListener('onPeerOpen', ({ peerId }) => {
        if (this.conn?.peerId !== peerId) return;
        this.conn.opened = true;
        if (!this.livePc) this.setState({ phase: 'connecting' });
      }),
      BabyNative.addListener('onPeerMessage', ({ peerId, message }) => {
        const conn = this.conn;
        if (conn?.peerId !== peerId) return;
        // Until the handshake is done, messages come from whatever answered on the monitor port:
        // anything unexpected drops the connection instead of crashing the app.
        try {
          for (const event of conn.endpoint.receive(message)) {
            if (this.conn !== conn) break;
            this.onEvent(conn, event);
          }
        } catch {
          this.fail(conn);
        }
      }),
      BabyNative.addListener('onPeerClose', ({ peerId }) => {
        if (this.conn?.peerId === peerId) this.fail(this.conn);
      }),
    ];
    BabyNative.startBrowsing();
    // Don't wait for Bonjour when we already know where the monitor lives.
    this.tryConnect();
    this.statsTimer = setInterval(() => void this.checkFrames(), 1000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.statsTimer);
    clearTimeout(this.browseRetry);
    this.subscriptions.forEach((subscription) => subscription.remove());
    BabyNative.stopBrowsing();
    if (this.conn) this.dispose(this.conn);
    this.conn = null;
    this.livePc?.close();
    this.livePc = null;
    this.retryTimer = undefined;
    this.setState({ phase: 'searching', stream: null, videoPaused: false });
  }

  /** Change the baby unit's settings from this device; it confirms with a 'settings' message. */
  updateMonitorSettings(patch: Partial<MonitorSettings>) {
    const current = this.state.monitorSettings;
    if (!this.conn?.endpoint.isOpen || !current) return;
    this.send(this.conn, { type: 'setSettings', settings: patch });
    this.setState({ monitorSettings: { ...current, ...patch } });
  }

  /** The user typed the code shown on the baby unit. */
  submitPairingCode(code: string) {
    this.pendingCode = code;
    if (this.state.pairing) {
      this.setState({ pairing: { ...this.state.pairing, checking: true, wrongCode: false, retryAt: null } });
    }
    const conn = this.conn;
    if (conn?.monitorId && conn.endpoint.canStart) this.next(conn);
  }

  /** The user doesn't want to pair with this baby unit: stop asking and look elsewhere. */
  cancelPairing() {
    const conn = this.conn;
    this.pendingCode = null;
    this.setState({ pairing: null });
    if (conn) {
      this.foreign.set(targetKey(conn.target), Infinity);
      this.fail(conn);
    }
  }

  /** Watch a monitor found by Bonjour (and remember it). */
  choose(name: string) {
    this.preferred = name;
    this.foreign.delete(targetKey({ kind: 'bonjour', name }));
    this.restartWith({ kind: 'bonjour', name });
  }

  /** Watch a monitor by IP address, for networks where Bonjour can't see it (and remember it). */
  connectAddress(host: string) {
    this.remember({ monitorAddresses: [host, ...this.remembered.monitorAddresses.filter((a) => a !== host)] });
    this.addressTurn = 0;
    this.foreign.delete(targetKey({ kind: 'address', host }));
    this.restartWith({ kind: 'address', host });
  }

  private restartWith(target: Target) {
    if (this.conn) this.dispose(this.conn);
    this.conn = null;
    if (this.state.outdated) this.setState({ outdated: null });
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connectTo(target, true);
  }

  private tryConnect() {
    this.retryTimer = undefined;
    if (this.stopped || this.conn || this.scanning) return;

    const monitors = this.state.monitors.filter((name) => !this.isForeign({ kind: 'bonjour', name }));
    const addresses = this.remembered.monitorAddresses.filter((host) => !this.isForeign({ kind: 'address', host }));
    const name =
      this.preferred && monitors.includes(this.preferred)
        ? this.preferred
        : monitors.length === 1
          ? monitors[0]
          : null;

    if (name) {
      this.connectTo({ kind: 'bonjour', name });
    } else if (this.addressTurn < addresses.length) {
      // Bonjour doesn't see it (its multicast may be filtered, or its cache is behind), or shows
      // several: try where the monitor was last time.
      this.connectTo({ kind: 'address', host: addresses[this.addressTurn++] });
    } else if (monitors.length > 1) {
      this.addressTurn = 0;
      this.setState({ phase: 'choosing' });
    } else {
      this.addressTurn = 0;
      const host = this.scanQueue.find((h) => !this.isForeign({ kind: 'address', host: h }));
      this.scanQueue = this.scanQueue.filter((h) => h !== host);
      if (host) this.connectTo({ kind: 'address', host });
      else void this.scan();
    }
  }

  /** Last resort that needs no Bonjour at all: knock on the monitor port of every address nearby. */
  private async scan() {
    this.scanning = true;
    const found = (await BabyNative.scanSubnet(MONITOR_PORT).catch(() => [] as string[])).filter(
      (host) => !this.isForeign({ kind: 'address', host }),
    );
    this.scanning = false;
    if (this.stopped || this.conn) return;

    if (found.length > 0) {
      // Try every host that answered, not just the first: a neighbour's may be quicker.
      this.scanQueue = found.slice(1);
      this.connectTo({ kind: 'address', host: found[0] });
    } else if (this.state.monitors.length > 0) {
      // Bonjour spotted something while we were scanning.
      this.tryConnect();
    } else {
      this.setState({ phase: this.livePc ? 'reconnecting' : 'searching' });
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.tryConnect(), SCAN_INTERVAL_MS);
    }
  }

  private connectTo(target: Target, explicit = false) {
    const peerId =
      target.kind === 'bonjour' ? BabyNative.connect(target.name) : BabyNative.connectAddress(target.host, MONITOR_PORT);
    const conn: Connection = {
      peerId,
      target,
      explicit,
      endpoint: new ParentEndpoint({
        random,
        parentId: this.credentials.parentId,
        send: (line) => BabyNative.send(peerId, line),
      }),
      keyRejected: false,
      justPaired: false,
      authenticated: false,
      opened: false,
      pc: null,
      stream: null,
      video: true,
      queue: Promise.resolve(),
      timeout: setTimeout(() => this.fail(conn), CONNECT_TIMEOUT_MS),
    };
    this.conn = conn;
    // Blind address attempts stay "searching" until the TCP connection actually opens.
    const phase = this.livePc ? 'reconnecting' : target.kind === 'bonjour' ? 'connecting' : this.state.phase;
    this.setState({ phase: phase === 'choosing' ? 'searching' : phase });
  }

  private onEvent(conn: Connection, event: ParentEvent) {
    switch (event.kind) {
      case 'welcome':
        conn.monitorId = event.monitorId;
        this.next(conn);
        break;
      case 'pairRequired':
        // The baby unit doesn't know our key (it got a new code, or it isn't the one we paired
        // with). Unauthenticated, so nothing stored changes: the key stays until a new pairing.
        conn.keyRejected = true;
        if (conn.monitorId) this.repairing.add(conn.monitorId);
        this.next(conn);
        break;
      case 'open':
        this.onAuthenticated(conn);
        break;
      case 'paired':
        // The baby unit proved it knows the code and accepted ours: keep the key.
        if (conn.monitorId) this.credentials.savePairing(conn.monitorId, event.pairingKey);
        conn.justPaired = true;
        this.onAuthenticated(conn);
        break;
      case 'message':
        this.onSignal(conn, event.text);
        break;
      case 'wrongCode':
        this.onWrongCode(conn);
        break;
      case 'wait':
        this.pendingCode = null;
        this.setState({
          pairing: { monitor: targetLabel(conn.target), checking: false, wrongCode: false, retryAt: Date.now() + event.ms },
        });
        this.fail(conn);
        break;
      case 'version':
        this.pendingCode = null;
        this.setState({ outdated: event.peerVersion < PROTOCOL_VERSION ? 'monitor' : 'parent', pairing: null });
        this.fail(conn, OUTDATED_RETRY_MS);
        break;
      case 'error':
        this.fail(conn);
        break;
    }
  }

  /** The connection waits for us: authenticate with the stored key, pair with a code, or ask for one. */
  private next(conn: Connection) {
    const monitorId = conn.monitorId;
    if (!monitorId) return;
    const step = nextParentStep({
      key: this.credentials.key(monitorId),
      keyRejected: conn.keyRejected,
      typedCode: this.pendingCode,
    });
    if (step.kind === 'auth') {
      conn.endpoint.auth(step.key);
      this.armTimeout(conn);
      return;
    }
    if (step.kind === 'pair') {
      conn.endpoint.pair(step.code);
      this.armTimeout(conn);
      return;
    }
    if (this.credentials.hasAny() && !conn.explicit && !this.repairing.has(monitorId)) {
      // Another family's baby unit on a shared network, or something posing as one at our baby
      // unit's name or address: skip it for a while, and look for ours elsewhere meanwhile.
      this.foreign.set(targetKey(conn.target), Date.now() + FOREIGN_MS);
      this.fail(conn);
      return;
    }
    // Keep the connection open while the user types the code.
    clearTimeout(conn.timeout);
    const previous = this.state.pairing;
    this.setState({
      pairing: {
        monitor: targetLabel(conn.target),
        checking: false,
        wrongCode: previous?.wrongCode ?? false,
        retryAt: previous?.retryAt ?? null,
      },
    });
  }

  private onWrongCode(conn: Connection) {
    // Either the code is wrong or whatever answered isn't the baby unit: nothing stored changes.
    if (conn.monitorId) this.repairing.add(conn.monitorId);
    this.pendingCode = null;
    this.setState({
      pairing: { monitor: targetLabel(conn.target), checking: false, wrongCode: true, retryAt: null },
    });
    this.fail(conn);
  }

  private isForeign(target: Target) {
    const until = this.foreign.get(targetKey(target));
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.foreign.delete(targetKey(target));
    return false;
  }

  /** Both sides proved who they are; now WebRTC has a few seconds to connect. */
  private onAuthenticated(conn: Connection) {
    conn.authenticated = true;
    if (conn.monitorId) this.repairing.delete(conn.monitorId);
    this.pendingCode = null;
    this.setState({ pairing: null, outdated: null });
    this.armTimeout(conn);
  }

  private armTimeout(conn: Connection) {
    clearTimeout(conn.timeout);
    conn.timeout = setTimeout(() => this.fail(conn), CONNECT_TIMEOUT_MS);
  }

  /** Encrypted for the baby unit; nothing goes out before the handshake is done. */
  private send(conn: Connection, message: SignalMessage) {
    if (conn.endpoint.isOpen) BabyNative.send(conn.peerId, conn.endpoint.seal(JSON.stringify(message)));
  }

  /** A message from the authenticated baby unit. */
  private onSignal(conn: Connection, text: string) {
    const message = parseSignal(text);
    if (!message) return;

    switch (message.type) {
      case 'hello': {
        // Baby units send IPv4 addresses; anything else would be saved and dialled on every launch.
        const addresses = Array.isArray(message.addresses)
          ? message.addresses.filter((a): a is string => typeof a === 'string' && IPV4.test(a)).slice(0, MAX_ADDRESSES)
          : [];
        const known = this.remembered.monitorAddresses;
        if (addresses.length > 0 && addresses.join() !== known.join()) {
          this.remember({ monitorAddresses: addresses });
        }
        break;
      }
      case 'status':
        // The authenticated baby unit still gets its values checked: they reach arithmetic, the
        // screen and the Live Activity bridge, where a wrong type would crash or blank the app.
        if (typeof message.video !== 'boolean') break;
        conn.video = message.video;
        if (conn.pc && conn.pc === this.livePc) this.setState({ videoPaused: !message.video });
        break;
      case 'motion':
        this.setState({ lastMotionAt: Date.now() });
        break;
      case 'sound':
        this.setState({ lastSoundAt: Date.now() });
        break;
      case 'cry':
        this.setState({ lastCryAt: Date.now() });
        break;
      case 'battery': {
        const { level, charging } = message;
        if (!isFiniteIn(level, -1, 1) || typeof charging !== 'boolean') break;
        this.setState({ monitorBattery: { level, charging } });
        break;
      }
      case 'settings': {
        const settings = completeMonitorSettings(message.settings);
        const endsAt = message.soundEndsAt;
        if (!settings || (endsAt !== null && !isFiniteIn(endsAt, 0, Number.MAX_SAFE_INTEGER))) break;
        this.setState({ monitorSettings: settings, monitorSoundEndsAt: endsAt });
        break;
      }
      case 'devices':
        this.onDevices(conn, message);
        break;
      case 'offer':
        if (typeof message.sdp !== 'string' || conn.pc) {
          this.fail(conn);
          break;
        }
        this.enqueue(conn, async () => {
          const pc = new RTCPeerConnection({ iceServers: [] });
          conn.pc = pc;
          listen(pc, 'track', ({ streams }) => {
            if (streams[0]) conn.stream = streams[0];
          });
          listen(pc, 'icecandidate', ({ candidate }) => {
            if (candidate) this.send(conn, { type: 'candidate', candidate: candidate.toJSON() });
          });
          listen(pc, 'connectionstatechange', () => this.onConnectionState(conn));

          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: message.sdp }));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.send(conn, { type: 'answer', sdp: answer.sdp });
        });
        break;
      case 'candidate':
        this.enqueue(conn, async () => {
          await conn.pc?.addIceCandidate(new RTCIceCandidate(message.candidate));
        });
        break;
    }
  }

  /**
   * The baby unit's device counts. More pairings with the current code than this device saw last
   * time (one more if it just paired itself): someone else paired, and the parent should know. The
   * pairing count, not the number of keys, so a pairing that replaced a key is noticed too.
   */
  private onDevices(conn: Connection, message: Record<string, unknown>) {
    const { paired, watching, pairings, generation } = message;
    if (!isCount(paired) || !isCount(watching)) return;
    this.setState({ monitorDevices: { paired, watching } });
    const monitorId = conn.monitorId;
    if (!monitorId || !isCount(pairings) || typeof generation !== 'string' || !GENERATION.test(generation)) return;
    const seen = this.remembered.pairedDevices;
    const stored = Object.prototype.hasOwnProperty.call(seen, monitorId) ? seen[monitorId] : undefined;
    const known =
      typeof stored === 'object' && stored !== null && stored.generation === generation && isCount(stored.pairings)
        ? stored.pairings
        : null;
    const expected = conn.justPaired ? (known === null ? null : known + 1) : known;
    if (expected !== null && pairings > expected) this.setState({ newDeviceAt: Date.now() });
    conn.justPaired = false;
    if (known !== pairings) this.remember({ pairedDevices: { ...seen, [monitorId]: { generation, pairings } } });
  }

  /** Notes when a new video frame was last decoded, so the screen can show a frozen picture as such. */
  private async checkFrames() {
    const pc = this.livePc;
    if (!pc) return;
    const stats: Map<string, { type?: string; kind?: string; framesDecoded?: number }> = await pc
      .getStats()
      .catch(() => new Map());
    let frames = 0;
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') frames = report.framesDecoded ?? 0;
    });
    if (pc !== this.framesSeen.pc) this.framesSeen = { pc, count: 0 };
    if (frames > this.framesSeen.count) {
      this.framesSeen.count = frames;
      this.setState({ lastFrameAt: Date.now() });
    }
  }

  private enqueue(conn: Connection, step: () => Promise<void>) {
    conn.queue = conn.queue.then(step).catch(() => this.fail(conn));
  }

  private onConnectionState(conn: Connection) {
    const pc = conn.pc;
    if (conn !== this.conn || !pc) return;

    switch (pc.connectionState) {
      case 'connected': {
        clearTimeout(conn.timeout);
        clearTimeout(conn.disconnectTimer);
        if (this.livePc && this.livePc !== pc) this.livePc.close();
        this.livePc = pc;
        this.addressTurn = 0;
        const { target } = conn;
        if (target.kind === 'bonjour') {
          this.preferred = target.name;
          if (this.remembered.lastMonitor !== target.name) this.remember({ lastMonitor: target.name });
        }
        this.setState({
          phase: 'live',
          stream: conn.stream,
          monitor: target.kind === 'bonjour' ? target.name : target.host,
          videoPaused: !conn.video,
        });
        break;
      }
      case 'disconnected':
        clearTimeout(conn.disconnectTimer);
        conn.disconnectTimer = setTimeout(() => this.fail(conn), DISCONNECT_GRACE_MS);
        break;
      case 'failed':
      case 'closed':
        this.fail(conn);
        break;
    }
  }

  private fail(conn: Connection, retryMs = RETRY_MS) {
    if (conn !== this.conn) return;
    this.conn = null;
    this.dispose(conn);
    // Something listens there but never proved itself: give the other places a turn first.
    if (conn.opened && !conn.authenticated && !conn.explicit && !this.isForeign(conn.target)) {
      this.foreign.set(targetKey(conn.target), Date.now() + SKIP_MS);
    }
    if (this.stopped) return;

    this.setState({ phase: this.livePc ? 'reconnecting' : 'searching' });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.tryConnect(), retryMs);
  }

  private dispose(conn: Connection) {
    clearTimeout(conn.timeout);
    clearTimeout(conn.disconnectTimer);
    BabyNative.closePeer(conn.peerId);
    // Keep the live connection open until a new one replaces it (see livePc).
    if (conn.pc && conn.pc !== this.livePc) conn.pc.close();
  }

  private remember(patch: Partial<Remembered>) {
    this.remembered = { ...this.remembered, ...patch };
    this.onRemember(patch);
  }
}

function isFiniteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000;
}

function targetKey(target: Target) {
  return target.kind === 'bonjour' ? `bonjour:${target.name}` : `address:${target.host}`;
}

function targetLabel(target: Target) {
  return target.kind === 'bonjour' ? target.name : target.host;
}
