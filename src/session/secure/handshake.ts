/**
 * Moonbeam signalling protocol, version 2: how a parent device and a baby unit authenticate each
 * other and then talk over an encrypted channel. Pure TypeScript (no React Native imports), so the
 * whole exchange is unit-tested under Node (handshake.test.ts) and mirrored by
 * tools/fake-baby-unit.py.
 *
 * Every line on the TCP connection is a JSON object.
 *
 *   baby → parent   welcome      { v, id, nonce }                    fresh 32-byte nonce nB
 *
 *   First pairing (the parent has no key for this baby unit; the user types the code):
 *   parent → baby   pair         { v, pid, nonce, y }                CPace share Ya, nonce nP
 *   baby → parent   pairReply    { y, mac }                          CPace share Yb, tag Tb
 *   parent → baby   pairConfirm  { mac }                             tag Ta, sent only if Tb is right
 *
 *   Later connections (the parent has a pairing key from an earlier pairing):
 *   parent → baby   auth         { v, pid, nonce, e, mac }           X25519 share, MAC with the key
 *   baby → parent   authOk       { e, mac }                          X25519 share, MAC with the key
 *               or  pairRequired {}                                  unknown parent: pair with the code
 *
 *   Then both ways  sealed       { box }                             ChaCha20-Poly1305, counter nonces
 *
 *   Refusals (unauthenticated, never acted on beyond showing a message):
 *   wait { ms } (too many code attempts), pairFailed {}, version { v }.
 *
 * Pairing runs CPace (cpace.ts), so someone without the code gets one guess per connection and
 * nothing to test further guesses offline. The pairing key derived from it never travels; later
 * connections prove knowledge of it with MACs over both sides' nonces, and an ephemeral X25519
 * exchange gives each connection fresh keys (forward secrecy). Nothing but these handshake messages
 * is processed before both sides are authenticated.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

import { concat, equalBytes, fromBase64, fromUtf8, lvCat, toBase64, utf8 } from './bytes.ts';
import {
  calculateGenerator,
  confirmationTag,
  intermediateKey,
  sampleScalar,
  scalarMult,
  scalarMultVfy,
} from './cpace.ts';

/** Bump whenever the wire format changes; both sides refuse other versions and say so. */
export const PROTOCOL_VERSION = 2;

/** Source of cryptographically secure random bytes (expo-crypto in the app, node:crypto in tests). */
export type Random = (length: number) => Uint8Array;

const LABEL = utf8('moonbeam/2');
const AD_PARENT = utf8('moonbeam/2 parent');
const AD_BABY = utf8('moonbeam/2 baby');
const NONCE_BYTES = 32;
const KEY_BYTES = 32;
const SHARE_BYTES = 32;
const TAG_BYTES = 64;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^\d{6}$/;

export class ProtocolError extends Error {}

type Fields = Record<string, unknown>;

function parse(line: string): Fields {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    throw new ProtocolError('not JSON');
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new ProtocolError('not an object');
  if (typeof (message as Fields).type !== 'string') throw new ProtocolError('no type');
  return message as Fields;
}

function bytesField(message: Fields, key: string, length: number): Uint8Array {
  const value = message[key];
  if (typeof value !== 'string') throw new ProtocolError(`missing ${key}`);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
  } catch {
    throw new ProtocolError(`bad ${key}`);
  }
  if (bytes.length !== length) throw new ProtocolError(`bad ${key}`);
  return bytes;
}

function idField(message: Fields, key: string): string {
  const value = message[key];
  if (typeof value !== 'string' || !ID.test(value)) throw new ProtocolError(`bad ${key}`);
  return value;
}

/** Version 1 messages carry no `v`. */
function versionOf(message: Fields): number {
  return typeof message.v === 'number' && Number.isInteger(message.v) ? message.v : 1;
}

function line(message: Fields): string {
  return JSON.stringify(message);
}

function randomBytes(random: Random, length: number): Uint8Array {
  const bytes = random(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('random source failed');
  return bytes;
}

/** A fresh id for a parent device: 16 random bytes, hex. */
export function newDeviceId(random: Random): string {
  return Array.from(randomBytes(random, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isValidId(id: string): boolean {
  return ID.test(id);
}

// --- Key schedule -------------------------------------------------------------------------------

type SessionKeys = { toBaby: Uint8Array; toParent: Uint8Array };

function derive(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return hkdf(sha512, ikm, salt, info, length);
}

function splitSessionKeys(okm: Uint8Array): SessionKeys {
  return { toBaby: okm.slice(0, KEY_BYTES), toParent: okm.slice(KEY_BYTES, 2 * KEY_BYTES) };
}

/**
 * CPace inputs. The identities go into CI (initiator first) and, with the protocol version and both
 * nonces, into the session id, so a run is bound to these two devices and this connection.
 */
function cpaceInputs(monitorId: string, parentId: string, monitorNonce: Uint8Array, parentNonce: Uint8Array) {
  const ci = lvCat(LABEL, utf8('parent'), utf8(parentId), utf8('baby'), utf8(monitorId));
  const sid = sha512(lvCat(LABEL, utf8('sid'), utf8(parentId), utf8(monitorId), monitorNonce, parentNonce)).slice(0, 32);
  return { ci, sid };
}

/** What both sides keep from a successful CPace run. */
function pairingOutputs(isk: Uint8Array, sid: Uint8Array) {
  return {
    pairingKey: derive(isk, sid, utf8('moonbeam/2 pairing key'), KEY_BYTES),
    keys: splitSessionKeys(derive(isk, sid, utf8('moonbeam/2 pairing session'), 2 * KEY_BYTES)),
  };
}

function authTranscript(
  monitorId: string,
  parentId: string,
  monitorNonce: Uint8Array,
  parentNonce: Uint8Array,
  parentShare: Uint8Array,
): Uint8Array {
  return lvCat(LABEL, utf8('auth'), utf8(monitorId), utf8(parentId), monitorNonce, parentNonce, parentShare);
}

function authMacs(pairingKey: Uint8Array, transcript: Uint8Array, babyShare: Uint8Array | null) {
  const empty = new Uint8Array(0);
  const parentKey = derive(pairingKey, empty, utf8('moonbeam/2 auth parent'), KEY_BYTES);
  const babyKey = derive(pairingKey, empty, utf8('moonbeam/2 auth baby'), KEY_BYTES);
  return {
    parent: hmac(sha512, parentKey, transcript),
    baby: babyShare ? hmac(sha512, babyKey, concat(transcript, lvCat(babyShare))) : null,
  };
}

/** Per-connection keys from the X25519 secret, authenticated by (and mixed with) the pairing key. */
function authSessionKeys(pairingKey: Uint8Array, shared: Uint8Array, transcript: Uint8Array, babyShare: Uint8Array) {
  const info = concat(utf8('moonbeam/2 auth session'), sha512(concat(transcript, lvCat(babyShare))));
  return splitSessionKeys(derive(shared, pairingKey, info, 2 * KEY_BYTES));
}

function dh(secret: Uint8Array, peerShare: Uint8Array): Uint8Array {
  // noble rejects low-order points; an all-zero result would mean the same.
  const shared = x25519.getSharedSecret(secret, peerShare);
  if (equalBytes(shared, new Uint8Array(shared.length))) throw new ProtocolError('bad share');
  return shared;
}

// --- Encrypted channel --------------------------------------------------------------------------

const MAX_COUNTER = 2 ** 48;

function counterNonce(counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  let n = counter;
  for (let i = 11; i >= 4; i--) {
    nonce[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return nonce;
}

/**
 * ChaCha20-Poly1305 with one key per direction and a message counter as the nonce: a message that
 * is altered, replayed, dropped or reordered fails to open, and the caller closes the connection.
 */
export class SecureChannel {
  private sendKey: Uint8Array;
  private receiveKey: Uint8Array;
  private sent = 0;
  private received = 0;

  constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    this.sendKey = sendKey;
    this.receiveKey = receiveKey;
  }

  seal(text: string): string {
    if (this.sent >= MAX_COUNTER) throw new ProtocolError('too many messages');
    const box = chacha20poly1305(this.sendKey, counterNonce(this.sent++), LABEL).encrypt(utf8(text));
    return line({ type: 'sealed', box: toBase64(box) });
  }

  /** The plaintext of the next message; throws for anything that doesn't decrypt. */
  open(raw: string): string {
    const message = parse(raw);
    if (message.type !== 'sealed' || typeof message.box !== 'string') throw new ProtocolError('not sealed');
    let box: Uint8Array;
    try {
      box = fromBase64(message.box);
    } catch {
      throw new ProtocolError('bad box');
    }
    let plain: Uint8Array;
    try {
      plain = chacha20poly1305(this.receiveKey, counterNonce(this.received), LABEL).decrypt(box);
    } catch {
      throw new ProtocolError('message does not authenticate');
    }
    this.received++;
    return fromUtf8(plain);
  }
}

// --- Rate limiting of code attempts (baby unit) -------------------------------------------------

/** How long a source's failed attempts count towards its backoff. */
const HOST_MEMORY_MS = 60 * 60_000;
const HOST_BACKOFF_MAX_MS = 5 * 60_000;
/** Failed code attempts from all sources together, per window. */
export const GLOBAL_LIMITS = [
  { windowMs: 10 * 60_000, max: 5 },
  { windowMs: 24 * 60 * 60_000, max: 20 },
];

/**
 * Limits code attempts on the baby unit. Every pairing attempt counts as a failure from the moment
 * the baby unit answers it (that answer is what lets a guesser test one code) until the parent
 * confirms the right code. Each source address waits 1 s, 2 s, 4 s … (up to 5 min) after its
 * failures, and all sources together get at most 5 failures per 10 minutes and 20 per day. The
 * limits apply only to pairing with the code: parents with a pairing key never go through here.
 */
export class PairingLimiter {
  private failures: { id: number; host: string; at: number }[] = [];
  private nextId = 1;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Milliseconds `host` has to wait before its next code attempt; 0 if it may try now. */
  check(host: string): number {
    const now = this.now();
    const longest = Math.max(HOST_MEMORY_MS, ...GLOBAL_LIMITS.map((limit) => limit.windowMs));
    this.failures = this.failures.filter((failure) => now - failure.at < longest);

    let wait = 0;
    const fromHost = this.failures.filter((failure) => failure.host === host && now - failure.at < HOST_MEMORY_MS);
    if (fromHost.length > 0) {
      const backoff = Math.min(1000 * 2 ** (fromHost.length - 1), HOST_BACKOFF_MAX_MS);
      wait = Math.max(wait, fromHost[fromHost.length - 1].at + backoff - now);
    }
    for (const { windowMs, max } of GLOBAL_LIMITS) {
      const recent = this.failures.filter((failure) => now - failure.at < windowMs);
      if (recent.length >= max) wait = Math.max(wait, recent[recent.length - max].at + windowMs - now);
    }
    return Math.max(0, wait);
  }

  /** An attempt is being answered: it counts as a failure unless `succeed` is called. */
  begin(host: string): number {
    const id = this.nextId++;
    this.failures.push({ id, host, at: this.now() });
    return id;
  }

  succeed(id: number) {
    this.failures = this.failures.filter((failure) => failure.id !== id);
  }

  /** A new code: earlier guesses no longer tell anyone anything. */
  reset() {
    this.failures = [];
  }
}

// --- Baby unit side -----------------------------------------------------------------------------

export type MonitorEvent =
  /** The parent speaks another protocol version. Close the connection (after a moment). */
  | { kind: 'outdated'; peerVersion: number }
  /** A parent paired before authenticated with its key: the channel is open. */
  | { kind: 'open'; parentId: string }
  /** A parent proved it knows the code: store `pairingKey` for it. The channel is open. */
  | { kind: 'paired'; parentId: string; pairingKey: Uint8Array }
  /** Too many code attempts; `wait` was sent. Close the connection (after a moment). */
  | { kind: 'limited'; ms: number }
  /** A decrypted message from an authenticated parent. */
  | { kind: 'message'; text: string }
  /** Anything else wrong: close the connection. */
  | { kind: 'error'; reason: string };

export type MonitorOptions = {
  random: Random;
  monitorId: string;
  /** The parent's address, for the per-source backoff. */
  host: string;
  send: (line: string) => void;
  /** The current pairing code. */
  code: () => string;
  /** The stored pairing key of a parent device, if it paired before. */
  parentKey: (parentId: string) => Uint8Array | null;
  limiter: PairingLimiter;
};

type MonitorStage = 'hello' | 'awaitPair' | 'confirm' | 'open' | 'closed';

/** One incoming connection on the baby unit. */
export class MonitorEndpoint {
  private options: MonitorOptions;
  private nonce: Uint8Array;
  private stage: MonitorStage = 'hello';
  private channel: SecureChannel | null = null;
  private pending: {
    parentId: string;
    token: number;
    /** The code this run used: a pairing that started before a new code must not finish after it. */
    code: string;
    sid: Uint8Array;
    isk: Uint8Array;
    parentShare: Uint8Array;
  } | null = null;

  constructor(options: MonitorOptions) {
    this.options = options;
    this.nonce = randomBytes(options.random, NONCE_BYTES);
  }

  /** The first message on every connection. */
  welcome() {
    // Version 1 parents read `id` and `nonce` too, answer with a `join` and learn they're outdated.
    this.options.send(line({ type: 'welcome', v: PROTOCOL_VERSION, id: this.options.monitorId, nonce: toBase64(this.nonce) }));
  }

  get isOpen() {
    return this.stage === 'open';
  }

  /** Still waiting for the parent's code (the user may be typing it). */
  get awaitingCode() {
    return this.stage === 'awaitPair';
  }

  seal(text: string): string {
    if (!this.channel || this.stage !== 'open') throw new ProtocolError('not open');
    return this.channel.seal(text);
  }

  receive(raw: string): MonitorEvent[] {
    try {
      return this.handle(raw);
    } catch (error) {
      this.stage = 'closed';
      return [{ kind: 'error', reason: error instanceof Error ? error.message : 'error' }];
    }
  }

  private handle(raw: string): MonitorEvent[] {
    if (this.stage === 'open' && this.channel) return [{ kind: 'message', text: this.channel.open(raw) }];
    if (this.stage === 'closed') throw new ProtocolError('closed');

    const message = parse(raw);
    if (this.stage === 'hello' || this.stage === 'awaitPair') {
      // Version 1 parents answer the welcome with `join`; later versions say which one they speak.
      const version = versionOf(message);
      if (message.type === 'join' || (message.v !== undefined && version !== PROTOCOL_VERSION)) {
        this.stage = 'closed';
        this.options.send(line({ type: 'version', v: PROTOCOL_VERSION }));
        return [{ kind: 'outdated', peerVersion: version }];
      }
      if (message.type === 'auth' && this.stage === 'hello') return this.onAuth(message);
      if (message.type === 'pair') return this.onPair(message);
    } else if (this.stage === 'confirm' && message.type === 'pairConfirm') {
      return this.onConfirm(message);
    }
    throw new ProtocolError(`unexpected ${String(message.type)}`);
  }

  private onAuth(message: Fields): MonitorEvent[] {
    const parentId = idField(message, 'pid');
    const parentNonce = bytesField(message, 'nonce', NONCE_BYTES);
    const parentShare = bytesField(message, 'e', SHARE_BYTES);
    const mac = bytesField(message, 'mac', TAG_BYTES);
    const pairingKey = this.options.parentKey(parentId);
    const transcript = authTranscript(this.options.monitorId, parentId, this.nonce, parentNonce, parentShare);
    if (!pairingKey || !equalBytes(mac, authMacs(pairingKey, transcript, null).parent)) {
      // Unknown parent, or one whose key this baby unit no longer has (a new code was created).
      this.stage = 'awaitPair';
      this.options.send(line({ type: 'pairRequired' }));
      return [];
    }
    const secret = randomBytes(this.options.random, KEY_BYTES);
    const babyShare = x25519.getPublicKey(secret);
    const shared = dh(secret, parentShare);
    const babyMac = authMacs(pairingKey, transcript, babyShare).baby as Uint8Array;
    const keys = authSessionKeys(pairingKey, shared, transcript, babyShare);
    this.options.send(line({ type: 'authOk', e: toBase64(babyShare), mac: toBase64(babyMac) }));
    this.channel = new SecureChannel(keys.toParent, keys.toBaby);
    this.stage = 'open';
    return [{ kind: 'open', parentId }];
  }

  private onPair(message: Fields): MonitorEvent[] {
    const parentId = idField(message, 'pid');
    const parentNonce = bytesField(message, 'nonce', NONCE_BYTES);
    const parentShare = bytesField(message, 'y', SHARE_BYTES);

    const wait = this.options.limiter.check(this.options.host);
    if (wait > 0) {
      this.stage = 'closed';
      this.options.send(line({ type: 'wait', ms: wait }));
      return [{ kind: 'limited', ms: wait }];
    }
    // From here on the parent can test one guess: count it until it proves the right code.
    const token = this.options.limiter.begin(this.options.host);

    const code = this.options.code();
    const { ci, sid } = cpaceInputs(this.options.monitorId, parentId, this.nonce, parentNonce);
    const generator = calculateGenerator(utf8(code), ci, sid);
    const scalar = sampleScalar(this.options.random);
    const babyShare = scalarMult(scalar, generator);
    const k = scalarMultVfy(scalar, parentShare);
    if (!k) throw new ProtocolError('bad share');
    const isk = intermediateKey(sid, k, parentShare, AD_PARENT, babyShare, AD_BABY);
    const tag = confirmationTag(sid, isk, babyShare, AD_BABY);
    this.pending = { parentId, token, code, sid, isk, parentShare };
    this.stage = 'confirm';
    this.options.send(line({ type: 'pairReply', y: toBase64(babyShare), mac: toBase64(tag) }));
    return [];
  }

  private onConfirm(message: Fields): MonitorEvent[] {
    const pending = this.pending;
    if (!pending) throw new ProtocolError('no pairing');
    const mac = bytesField(message, 'mac', TAG_BYTES);
    const expected = confirmationTag(pending.sid, pending.isk, pending.parentShare, AD_PARENT);
    this.pending = null;
    if (this.options.code() !== pending.code) {
      this.stage = 'closed';
      return [{ kind: 'error', reason: 'code changed' }];
    }
    if (!equalBytes(mac, expected)) {
      this.stage = 'closed';
      this.options.send(line({ type: 'pairFailed' }));
      return [{ kind: 'error', reason: 'wrong code' }];
    }
    this.options.limiter.succeed(pending.token);
    const { pairingKey, keys } = pairingOutputs(pending.isk, pending.sid);
    this.channel = new SecureChannel(keys.toParent, keys.toBaby);
    this.stage = 'open';
    return [{ kind: 'paired', parentId: pending.parentId, pairingKey }];
  }
}

// --- Parent side --------------------------------------------------------------------------------

export type ParentEvent =
  /** The baby unit introduced itself. Next: `auth()` with a stored key, or `pair()` with a code. */
  | { kind: 'welcome'; monitorId: string }
  /** The baby unit speaks another protocol version (1 = before this one). Close. */
  | { kind: 'version'; peerVersion: number }
  /** The baby unit doesn't accept our key: `pair()` on this connection, once the user typed the code. */
  | { kind: 'pairRequired' }
  /** Too many code attempts on the baby unit. Close. */
  | { kind: 'wait'; ms: number }
  /**
   * The code was wrong, or whatever answered isn't the baby unit it claims to be (the two are
   * indistinguishable by design). Close; keep everything stored.
   */
  | { kind: 'wrongCode' }
  /** Authenticated with the stored key: the channel is open. */
  | { kind: 'open' }
  /** The baby unit accepted the new pairing: store `pairingKey`. The channel is open. */
  | { kind: 'paired'; pairingKey: Uint8Array }
  /** A decrypted message from the authenticated baby unit. */
  | { kind: 'message'; text: string }
  /** Anything else wrong: close. */
  | { kind: 'error'; reason: string };

export type ParentOptions = {
  random: Random;
  parentId: string;
  send: (line: string) => void;
};

type ParentStage = 'welcome' | 'idle' | 'auth' | 'pair' | 'confirmed' | 'open' | 'closed';

/** One connection from a parent device to a baby unit. */
export class ParentEndpoint {
  monitorId: string | null = null;
  private options: ParentOptions;
  private stage: ParentStage = 'welcome';
  private monitorNonce: Uint8Array | null = null;
  private channel: SecureChannel | null = null;
  private authState: { pairingKey: Uint8Array; secret: Uint8Array; transcript: Uint8Array } | null = null;
  private pairState: { scalar: bigint; share: Uint8Array; sid: Uint8Array } | null = null;
  private newPairingKey: Uint8Array | null = null;

  constructor(options: ParentOptions) {
    this.options = options;
  }

  get isOpen() {
    return this.stage === 'open';
  }

  /** The connection is waiting for us to send `auth` or `pair`. */
  get canStart() {
    return this.stage === 'idle';
  }

  auth(pairingKey: Uint8Array) {
    if (this.stage !== 'idle' || !this.monitorId || !this.monitorNonce) throw new ProtocolError('not ready');
    const parentNonce = randomBytes(this.options.random, NONCE_BYTES);
    const secret = randomBytes(this.options.random, KEY_BYTES);
    const share = x25519.getPublicKey(secret);
    const transcript = authTranscript(this.monitorId, this.options.parentId, this.monitorNonce, parentNonce, share);
    const mac = authMacs(pairingKey, transcript, null).parent;
    this.authState = { pairingKey, secret, transcript };
    this.stage = 'auth';
    this.options.send(
      line({
        type: 'auth',
        v: PROTOCOL_VERSION,
        pid: this.options.parentId,
        nonce: toBase64(parentNonce),
        e: toBase64(share),
        mac: toBase64(mac),
      }),
    );
  }

  pair(code: string) {
    if (this.stage !== 'idle' || !this.monitorId || !this.monitorNonce) throw new ProtocolError('not ready');
    if (!CODE.test(code)) throw new ProtocolError('bad code');
    const parentNonce = randomBytes(this.options.random, NONCE_BYTES);
    const { ci, sid } = cpaceInputs(this.monitorId, this.options.parentId, this.monitorNonce, parentNonce);
    const scalar = sampleScalar(this.options.random);
    const share = scalarMult(scalar, calculateGenerator(utf8(code), ci, sid));
    this.pairState = { scalar, share, sid };
    this.stage = 'pair';
    this.options.send(
      line({ type: 'pair', v: PROTOCOL_VERSION, pid: this.options.parentId, nonce: toBase64(parentNonce), y: toBase64(share) }),
    );
  }

  seal(text: string): string {
    if (!this.channel || this.stage !== 'open') throw new ProtocolError('not open');
    return this.channel.seal(text);
  }

  receive(raw: string): ParentEvent[] {
    try {
      return this.handle(raw);
    } catch (error) {
      this.stage = 'closed';
      return [{ kind: 'error', reason: error instanceof Error ? error.message : 'error' }];
    }
  }

  private handle(raw: string): ParentEvent[] {
    if (this.stage === 'open' && this.channel) return [{ kind: 'message', text: this.channel.open(raw) }];
    if (this.stage === 'confirmed' && this.channel) {
      // The first sealed message shows the baby unit accepted our confirmation: only now is the
      // new pairing key worth keeping.
      const message = parse(raw);
      if (message.type === 'sealed') {
        const text = this.channel.open(raw);
        const pairingKey = this.newPairingKey as Uint8Array;
        this.newPairingKey = null;
        this.stage = 'open';
        return [{ kind: 'paired', pairingKey }, { kind: 'message', text }];
      }
      throw new ProtocolError(`unexpected ${String(message.type)}`);
    }
    if (this.stage === 'closed') throw new ProtocolError('closed');

    const message = parse(raw);
    if (message.type === 'version') {
      this.stage = 'closed';
      return [{ kind: 'version', peerVersion: versionOf(message) }];
    }
    switch (this.stage) {
      case 'welcome':
        if (message.type !== 'welcome') break;
        if (versionOf(message) !== PROTOCOL_VERSION) {
          this.stage = 'closed';
          return [{ kind: 'version', peerVersion: versionOf(message) }];
        }
        this.monitorId = idField(message, 'id');
        this.monitorNonce = bytesField(message, 'nonce', NONCE_BYTES);
        this.stage = 'idle';
        return [{ kind: 'welcome', monitorId: this.monitorId }];
      case 'auth':
        if (message.type === 'authOk') return this.onAuthOk(message);
        if (message.type === 'pairRequired') {
          this.authState = null;
          this.stage = 'idle';
          return [{ kind: 'pairRequired' }];
        }
        break;
      case 'pair':
        if (message.type === 'pairReply') return this.onPairReply(message);
        if (message.type === 'wait') {
          this.stage = 'closed';
          const ms = typeof message.ms === 'number' && message.ms > 0 ? Math.min(message.ms, 24 * 60 * 60_000) : 60_000;
          return [{ kind: 'wait', ms }];
        }
        break;
    }
    throw new ProtocolError(`unexpected ${String(message.type)}`);
  }

  private onAuthOk(message: Fields): ParentEvent[] {
    const state = this.authState;
    if (!state) throw new ProtocolError('no auth');
    const babyShare = bytesField(message, 'e', SHARE_BYTES);
    const mac = bytesField(message, 'mac', TAG_BYTES);
    const expected = authMacs(state.pairingKey, state.transcript, babyShare).baby as Uint8Array;
    if (!equalBytes(mac, expected)) throw new ProtocolError('baby unit failed to authenticate');
    const keys = authSessionKeys(state.pairingKey, dh(state.secret, babyShare), state.transcript, babyShare);
    this.authState = null;
    this.channel = new SecureChannel(keys.toBaby, keys.toParent);
    this.stage = 'open';
    return [{ kind: 'open' }];
  }

  private onPairReply(message: Fields): ParentEvent[] {
    const state = this.pairState;
    if (!state) throw new ProtocolError('no pairing');
    this.pairState = null;
    const babyShare = bytesField(message, 'y', SHARE_BYTES);
    const tag = bytesField(message, 'mac', TAG_BYTES);
    const k = scalarMultVfy(state.scalar, babyShare);
    if (!k) throw new ProtocolError('bad share');
    const isk = intermediateKey(state.sid, k, state.share, AD_PARENT, babyShare, AD_BABY);
    if (!equalBytes(tag, confirmationTag(state.sid, isk, babyShare, AD_BABY))) {
      // Send nothing: a fake baby unit learns no more than that its single guess was wrong.
      this.stage = 'closed';
      return [{ kind: 'wrongCode' }];
    }
    const { pairingKey, keys } = pairingOutputs(isk, state.sid);
    this.options.send(line({ type: 'pairConfirm', mac: toBase64(confirmationTag(state.sid, isk, state.share, AD_PARENT)) }));
    this.channel = new SecureChannel(keys.toBaby, keys.toParent);
    this.newPairingKey = pairingKey;
    this.stage = 'confirmed';
    return [];
  }
}
