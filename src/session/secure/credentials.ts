/**
 * The secrets each device keeps, independent of where they are stored (the Keychain in the app, see
 * src/secrets.ts; plain objects in the tests). Codes saved by version 1 are never taken over: version
 * 1 let anyone who recorded a pairing work the code out offline, and parents that haven't been updated
 * keep sending such proofs, so the update starts with a new code.
 */
import { fromBase64, toBase64 } from './bytes.ts';
import { isValidId } from './handshake.ts';

/** Enough for every parent device a family has; the oldest pairing goes first beyond that. */
export const MAX_PAIRINGS = 16;
const CODE = /^\d{6}$/;

export type MonitorSecrets = {
  /** The 6-digit code shown on the baby unit, needed only to pair a new parent device. */
  code: string;
  /** Pairing keys of parent devices (base64), by parent id, oldest first. */
  parentKeys: Record<string, string>;
  /**
   * Successful pairings since this code was created. Unlike the number of keys it never goes down:
   * a pairing that replaces another parent's key (ids are visible on the network) or pushes out the
   * oldest one still counts, so parents can notice it.
   */
  pairings: number;
  /** Random id of this code, so parents can tell a new code (pairings back at 0) from a lower count. */
  generation: string;
};

const GENERATION = /^[0-9a-f]{16,64}$/;

export type ParentSecrets = {
  /** This parent device's id, sent when it pairs and authenticates. */
  parentId: string;
  /** Pairing keys (base64) by baby unit id, oldest first. */
  monitorKeys: Record<string, string>;
};

/** Own entries only: an id such as `constructor` must not find something inherited. */
function entry(map: Record<string, string>, id: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

function decodeKey(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  try {
    const key = fromBase64(value);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function withLatest(map: Record<string, string>, id: string, value: string): Record<string, string> {
  const { [id]: _previous, ...rest } = map;
  const entries = Object.entries(rest);
  return Object.fromEntries([...entries.slice(Math.max(0, entries.length - (MAX_PAIRINGS - 1))), [id, value]]);
}

/** Baby unit: its code and the keys of the parents that paired with it. */
export class MonitorCredentials {
  private secrets: MonitorSecrets;
  /** True once the secrets are stored. */
  private persist: (secrets: MonitorSecrets) => boolean;

  constructor(secrets: MonitorSecrets, persist: (secrets: MonitorSecrets) => boolean) {
    this.secrets = secrets;
    this.persist = persist;
  }

  get code() {
    return this.secrets.code;
  }

  parentKey(parentId: string): Uint8Array | null {
    return decodeKey(entry(this.secrets.parentKeys, parentId));
  }

  /** Parent devices paired with this baby unit (each keeps its own key). */
  get pairedCount() {
    return Object.keys(this.secrets.parentKeys).length;
  }

  get pairings() {
    return this.secrets.pairings;
  }

  get generation() {
    return this.secrets.generation;
  }

  saveParentKey(parentId: string, key: Uint8Array) {
    // Kept in memory even if the Keychain refuses: this parent works until the app restarts.
    this.secrets = {
      ...this.secrets,
      parentKeys: withLatest(this.secrets.parentKeys, parentId, toBase64(key)),
      pairings: this.secrets.pairings + 1,
    };
    this.persist(this.secrets);
  }

  /**
   * A new code also forgets every parent: each has to pair again with the new code. Nothing changes
   * unless it's saved (returns false then): a new code that held only until the next restart would
   * bring back the old code and every old parent without anyone noticing.
   */
  setCode(code: string, generation: string): boolean {
    if (!CODE.test(code) || !GENERATION.test(generation)) throw new Error('bad code');
    const secrets = { code, parentKeys: {}, pairings: 0, generation };
    if (!this.persist(secrets)) return false;
    this.secrets = secrets;
    return true;
  }
}

/** Parent unit: its id and the keys for the baby units it paired with. */
export class ParentCredentials {
  private secrets: ParentSecrets;
  private persist: (secrets: ParentSecrets) => void;

  constructor(secrets: ParentSecrets, persist: (secrets: ParentSecrets) => void) {
    this.secrets = secrets;
    this.persist = persist;
  }

  get parentId() {
    return this.secrets.parentId;
  }

  key(monitorId: string): Uint8Array | null {
    return decodeKey(entry(this.secrets.monitorKeys, monitorId));
  }

  /** Paired with any baby unit. */
  hasAny() {
    return Object.keys(this.secrets.monitorKeys).length > 0;
  }

  /**
   * Only after the baby unit proved it knows the code and accepted ours. Nothing an
   * unauthenticated peer says ever removes a key.
   */
  savePairing(monitorId: string, key: Uint8Array) {
    this.update({ ...this.secrets, monitorKeys: withLatest(this.secrets.monitorKeys, monitorId, toBase64(key)) });
  }

  private update(secrets: ParentSecrets) {
    this.secrets = secrets;
    this.persist(secrets);
  }
}

export type ParentStep =
  | { kind: 'auth'; key: Uint8Array }
  | { kind: 'pair'; code: string }
  /** Show the pairing sheet and wait for the user. */
  | { kind: 'ask' };

/**
 * What a parent sends on a connection that waits for it: the stored key first; if the baby unit
 * doesn't take it (or there is none), the code the user typed.
 */
export function nextParentStep(input: {
  key: Uint8Array | null;
  /** The baby unit answered our key with `pairRequired` on this connection. */
  keyRejected: boolean;
  typedCode: string | null;
}): ParentStep {
  if (input.key && !input.keyRejected) return { kind: 'auth', key: input.key };
  if (input.typedCode) return { kind: 'pair', code: input.typedCode };
  return { kind: 'ask' };
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function stringMap(value: unknown, valid: (key: string, value: string) => boolean): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && valid(entry[0], entry[1]),
    ),
  );
}

const validKey = (id: string, key: string) => isValidId(id) && decodeKey(key) !== null;

/**
 * Reads the stored baby unit secrets (JSON from the Keychain), or creates a new code if there are
 * none (first launch, or the first launch after updating from version 1). `changed` means the result
 * has to be saved.
 */
export function loadMonitorSecrets(
  stored: string | null,
  newCode: () => string,
  newGeneration: () => string,
): { secrets: MonitorSecrets; changed: boolean } {
  const parsed = parseJson(stored);
  if (parsed && typeof parsed.code === 'string' && CODE.test(parsed.code)) {
    const parentKeys = stringMap(parsed.parentKeys, validKey);
    const keys = Object.keys(parentKeys).length;
    const counted = typeof parsed.pairings === 'number' && Number.isInteger(parsed.pairings) && parsed.pairings >= keys;
    const named = typeof parsed.generation === 'string' && GENERATION.test(parsed.generation);
    const secrets = {
      code: parsed.code,
      parentKeys,
      pairings: counted ? (parsed.pairings as number) : keys,
      generation: named ? (parsed.generation as string) : newGeneration(),
    };
    return { secrets, changed: !counted || !named };
  }
  return { secrets: { code: newCode(), parentKeys: {}, pairings: 0, generation: newGeneration() }, changed: true };
}

/** Reads the stored parent secrets, creating the parent id on first launch. */
export function loadParentSecrets(
  stored: string | null,
  newId: () => string,
): { secrets: ParentSecrets; changed: boolean } {
  const parsed = parseJson(stored);
  const storedId = typeof parsed?.parentId === 'string' && isValidId(parsed.parentId) ? parsed.parentId : null;
  const monitorKeys = stringMap(parsed?.monitorKeys, validKey);
  return { secrets: { parentId: storedId ?? newId(), monitorKeys }, changed: storedId === null };
}
