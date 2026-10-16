/// <reference types="node" />
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { fromBase64, toBase64 } from './bytes.ts';
import {
  loadMonitorSecrets,
  loadParentSecrets,
  MonitorCredentials,
  nextParentStep,
  ParentCredentials,
} from './credentials.ts';
import {
  MonitorEndpoint,
  type MonitorEvent,
  PairingLimiter,
  ParentEndpoint,
  type ParentEvent,
  PROTOCOL_VERSION,
} from './handshake.ts';

const random = (length: number) => new Uint8Array(randomBytes(length));
const MONITOR_ID = '1234567890123456';
const PARENT_ID = 'aa'.repeat(16);
const GEN = 'ab'.repeat(16);
const GEN2 = 'cd'.repeat(16);

type Baby = {
  endpoint: MonitorEndpoint;
  /** Lines the baby unit sent, not yet delivered. */
  out: string[];
  keys: Map<string, Uint8Array>;
  limiter: PairingLimiter;
};

function baby(options: { code?: string; keys?: Map<string, Uint8Array>; limiter?: PairingLimiter; host?: string } = {}): Baby {
  const out: string[] = [];
  const keys = options.keys ?? new Map<string, Uint8Array>();
  const limiter = options.limiter ?? new PairingLimiter();
  const endpoint = new MonitorEndpoint({
    random,
    monitorId: MONITOR_ID,
    host: options.host ?? '192.168.1.20',
    send: (line) => out.push(line),
    code: () => options.code ?? '123456',
    parentKey: (id) => keys.get(id) ?? null,
    limiter,
  });
  endpoint.welcome();
  return { endpoint, out, keys, limiter };
}

function parent(parentId = PARENT_ID) {
  const out: string[] = [];
  const endpoint = new ParentEndpoint({ random, parentId, send: (line) => out.push(line) });
  return { endpoint, out };
}

function take(lines: string[]): string {
  const line = lines.shift();
  assert.ok(line, 'expected a message');
  return line;
}

/** Delivers the baby unit's pending lines to the parent and returns the parent's events. */
function toParent(b: Baby, p: ReturnType<typeof parent>): ParentEvent[] {
  const events: ParentEvent[] = [];
  while (b.out.length > 0) events.push(...p.endpoint.receive(take(b.out)));
  return events;
}

function toBaby(p: ReturnType<typeof parent>, b: Baby): MonitorEvent[] {
  const events: MonitorEvent[] = [];
  while (p.out.length > 0) events.push(...b.endpoint.receive(take(p.out)));
  return events;
}

function kinds(events: { kind: string }[]) {
  return events.map((event) => event.kind);
}

/** Pairs a fresh parent with the code; returns the key both sides agreed on. */
function pairOnce(b: Baby, p: ReturnType<typeof parent>, code = '123456') {
  assert.deepEqual(kinds(toParent(b, p)), ['welcome']);
  p.endpoint.pair(code);
  assert.deepEqual(toBaby(p, b), []);
  assert.deepEqual(toParent(b, p), []);
  const babyEvents = toBaby(p, b);
  assert.equal(babyEvents.length, 1);
  const paired = babyEvents[0];
  assert.equal(paired.kind, 'paired');
  if (paired.kind !== 'paired') throw new Error();
  b.out.push(b.endpoint.seal('{"type":"hello","addresses":[]}'));
  const parentEvents = toParent(b, p);
  assert.deepEqual(kinds(parentEvents), ['paired', 'message']);
  const parentPaired = parentEvents[0];
  if (parentPaired.kind !== 'paired') throw new Error();
  assert.deepEqual(parentPaired.pairingKey, paired.pairingKey);
  assert.equal(paired.parentId, PARENT_ID);
  return paired.pairingKey;
}

test('pairing with the right code opens an encrypted channel both ways', () => {
  const b = baby();
  const p = parent();
  const key = pairOnce(b, p);
  assert.equal(key.length, 32);
  assert.ok(p.endpoint.isOpen && b.endpoint.isOpen);

  b.out.push(b.endpoint.seal('{"type":"motion"}'));
  assert.deepEqual(toParent(b, p), [{ kind: 'message', text: '{"type":"motion"}' }]);
  p.out.push(p.endpoint.seal('{"type":"setSettings","settings":{"night":"on"}}'));
  assert.deepEqual(toBaby(p, b), [{ kind: 'message', text: '{"type":"setSettings","settings":{"night":"on"}}' }]);
  // A successful pairing doesn't count against the code limits.
  assert.equal(b.limiter.check('192.168.1.20'), 0);
});

test('the code and the keys never appear on the wire', () => {
  const b = baby({ code: '987654' });
  const p = parent();
  const wire: string[] = [];
  const record = (lines: string[]) => wire.push(...lines);
  record(b.out);
  toParent(b, p);
  p.endpoint.pair('987654');
  record(p.out);
  toBaby(p, b);
  record(b.out);
  toParent(b, p);
  record(p.out);
  const [event] = toBaby(p, b);
  if (event.kind !== 'paired') throw new Error();
  const text = wire.join('\n');
  assert.ok(!text.includes('987654'));
  assert.ok(!text.includes(toBase64(event.pairingKey)));
});

test('a stored key authenticates later connections without the code', () => {
  const keys = new Map<string, Uint8Array>();
  const key = pairOnce(baby({ keys }), parent());
  keys.set(PARENT_ID, key);

  const b = baby({ keys, code: '000000' });
  const p = parent();
  assert.deepEqual(kinds(toParent(b, p)), ['welcome']);
  p.endpoint.auth(key);
  assert.deepEqual(toBaby(p, b), [{ kind: 'open', parentId: PARENT_ID }]);
  assert.deepEqual(toParent(b, p), [{ kind: 'open' }]);
  b.out.push(b.endpoint.seal('{"type":"cry"}'));
  assert.deepEqual(toParent(b, p), [{ kind: 'message', text: '{"type":"cry"}' }]);
});

test('a wrong code fails on the parent before it sends its confirmation', () => {
  const b = baby({ code: '123456' });
  const p = parent();
  toParent(b, p);
  p.endpoint.pair('123457');
  toBaby(p, b);
  assert.deepEqual(toParent(b, p), [{ kind: 'wrongCode' }]);
  assert.equal(p.out.length, 0, 'nothing more goes to a baby unit that may be fake');
  assert.ok(!p.endpoint.isOpen);
  // The baby unit counted the attempt.
  assert.ok(b.limiter.check('192.168.1.20') > 0);
});

test('a parent that guesses wrong and confirms anyway is refused', () => {
  // A malicious parent learns from pairReply whether its one guess was right; a bad pairConfirm
  // gets pairFailed and nothing else.
  const b = baby({ code: '123456' });
  const fake = parent();
  toParent(b, fake);
  fake.endpoint.pair('111111');
  toBaby(fake, b);
  take(b.out); // pairReply
  const events = b.endpoint.receive(JSON.stringify({ type: 'pairConfirm', mac: toBase64(random(64)) }));
  assert.deepEqual(kinds(events), ['error']);
  assert.deepEqual(JSON.parse(take(b.out)), { type: 'pairFailed' });
  assert.ok(b.limiter.check('192.168.1.20') > 0, 'the guess counts');
});

test('an unknown parent with a key is asked to pair, and can on the same connection', () => {
  const b = baby({ keys: new Map() });
  const p = parent();
  toParent(b, p);
  p.endpoint.auth(random(32));
  assert.deepEqual(toBaby(p, b), []);
  assert.deepEqual(toParent(b, p), [{ kind: 'pairRequired' }]);
  assert.ok(b.endpoint.awaitingCode);
  p.endpoint.pair('123456');
  toBaby(p, b);
  toParent(b, p);
  assert.deepEqual(kinds(toBaby(p, b)), ['paired']);
});

test('a wrong key is treated like an unknown parent, never as a code attempt', () => {
  const keys = new Map([[PARENT_ID, random(32)]]);
  const b = baby({ keys });
  const p = parent();
  toParent(b, p);
  p.endpoint.auth(random(32));
  toBaby(p, b);
  assert.deepEqual(toParent(b, p), [{ kind: 'pairRequired' }]);
  assert.equal(b.limiter.check('192.168.1.20'), 0);
});

test('tampered handshake messages are rejected', () => {
  // pairReply with a flipped tag bit: the parent sees a wrong code (it can't tell the difference).
  {
    const b = baby();
    const p = parent();
    toParent(b, p);
    p.endpoint.pair('123456');
    toBaby(p, b);
    const reply = JSON.parse(take(b.out));
    const mac = fromBase64(reply.mac);
    mac[0] ^= 1;
    assert.deepEqual(p.endpoint.receive(JSON.stringify({ ...reply, mac: toBase64(mac) })), [{ kind: 'wrongCode' }]);
  }
  // pairReply with a different share: K differs, so the tag doesn't verify.
  {
    const b = baby();
    const p = parent();
    toParent(b, p);
    p.endpoint.pair('123456');
    toBaby(p, b);
    const reply = JSON.parse(take(b.out));
    const other = baby();
    const q = parent();
    toParent(other, q);
    q.endpoint.pair('123456');
    toBaby(q, other);
    const otherReply = JSON.parse(take(other.out));
    assert.deepEqual(p.endpoint.receive(JSON.stringify({ ...reply, y: otherReply.y })), [{ kind: 'wrongCode' }]);
  }
  // authOk with a wrong MAC: someone without the key answered.
  {
    const keys = new Map<string, Uint8Array>();
    const key = random(32);
    keys.set(PARENT_ID, key);
    const b = baby({ keys });
    const p = parent();
    toParent(b, p);
    p.endpoint.auth(key);
    toBaby(p, b);
    const ok = JSON.parse(take(b.out));
    const mac = fromBase64(ok.mac);
    mac[10] ^= 0x80;
    assert.deepEqual(kinds(p.endpoint.receive(JSON.stringify({ ...ok, mac: toBase64(mac) }))), ['error']);
    assert.ok(!p.endpoint.isOpen);
  }
  // auth with a tampered share: the MAC covers it, so the baby unit asks to pair instead.
  {
    const keys = new Map<string, Uint8Array>();
    const key = random(32);
    keys.set(PARENT_ID, key);
    const b = baby({ keys });
    const p = parent();
    toParent(b, p);
    p.endpoint.auth(key);
    const auth = JSON.parse(take(p.out));
    assert.deepEqual(b.endpoint.receive(JSON.stringify({ ...auth, e: toBase64(random(32)) })), []);
    assert.deepEqual(JSON.parse(take(b.out)), { type: 'pairRequired' });
  }
  // A sealed message with one bit flipped closes the channel.
  {
    const b = baby();
    const p = parent();
    pairOnce(b, p);
    const sealed = JSON.parse(b.endpoint.seal('{"type":"motion"}'));
    const box = fromBase64(sealed.box);
    box[3] ^= 1;
    assert.deepEqual(kinds(p.endpoint.receive(JSON.stringify({ type: 'sealed', box: toBase64(box) }))), ['error']);
  }
  // Plain (unsealed) messages are ignored as errors once the channel is open.
  {
    const b = baby();
    const p = parent();
    pairOnce(b, p);
    assert.deepEqual(kinds(p.endpoint.receive('{"type":"motion"}')), ['error']);
    assert.deepEqual(kinds(b.endpoint.receive('{"type":"setSettings","settings":{}}')), ['error']);
  }
});

test('nothing but the handshake is processed before authentication', () => {
  const p = parent();
  const b = baby();
  // App messages before the welcome, or instead of authOk, close the connection.
  assert.deepEqual(kinds(p.endpoint.receive('{"type":"motion"}')), ['error']);
  assert.deepEqual(kinds(b.endpoint.receive('{"type":"setSettings","v":2,"settings":{"role":"monitor"}}')), ['error']);

  const q = parent();
  const c = baby();
  toParent(c, q);
  q.endpoint.pair('123456');
  assert.deepEqual(kinds(q.endpoint.receive('{"type":"battery","level":0.01,"charging":false}')), ['error']);
  // And a sealed message from a stranger (no keys) doesn't open either.
  const r = parent();
  const d = baby();
  toParent(d, r);
  r.endpoint.pair('123456');
  toBaby(r, d);
  take(d.out);
  assert.deepEqual(kinds(r.endpoint.receive(JSON.stringify({ type: 'sealed', box: toBase64(random(40)) }))), ['error']);
});

test('replayed messages are rejected', () => {
  // An auth message replayed on a new connection: the new welcome nonce doesn't match.
  const keys = new Map<string, Uint8Array>();
  const key = random(32);
  keys.set(PARENT_ID, key);
  const first = baby({ keys });
  const p = parent();
  toParent(first, p);
  p.endpoint.auth(key);
  const auth = take(p.out);
  first.endpoint.receive(auth);
  const second = baby({ keys });
  take(second.out); // its own welcome, with a new nonce
  assert.deepEqual(second.endpoint.receive(auth), []);
  assert.deepEqual(JSON.parse(take(second.out)), { type: 'pairRequired' });

  // An authOk replayed to a new parent connection: our new nonce doesn't match.
  const authOk = take(first.out);
  const b2 = baby({ keys });
  const p2 = parent();
  toParent(b2, p2);
  p2.endpoint.auth(key);
  assert.deepEqual(kinds(p2.endpoint.receive(authOk)), ['error']);

  // A pairConfirm replayed on a new connection: different nonces, different session.
  const b3 = baby();
  const p3 = parent();
  toParent(b3, p3);
  p3.endpoint.pair('123456');
  toBaby(p3, b3);
  toParent(b3, p3);
  const confirm = take(p3.out);
  b3.endpoint.receive(confirm);
  const b4 = baby();
  const p4 = parent();
  toParent(b4, p4);
  p4.endpoint.pair('654321'); // whatever: the attacker just replays
  toBaby(p4, b4);
  assert.deepEqual(kinds(b4.endpoint.receive(confirm)), ['error']);

  // A sealed message delivered twice: the counter has moved on.
  const b5 = baby();
  const p5 = parent();
  pairOnce(b5, p5);
  const motion = b5.endpoint.seal('{"type":"motion"}');
  assert.deepEqual(kinds(p5.endpoint.receive(motion)), ['message']);
  assert.deepEqual(kinds(p5.endpoint.receive(motion)), ['error']);
});

test('a sealed message from one direction is not accepted in the other', () => {
  const b = baby();
  const p = parent();
  pairOnce(b, p);
  const fromParent = p.endpoint.seal('{"type":"setSettings","settings":{}}');
  // Reflected back to the parent at the same counter position: different key.
  assert.deepEqual(kinds(p.endpoint.receive(fromParent)), ['error']);
});

test('identity and invalid shares abort the run', () => {
  for (const share of [new Uint8Array(32), new Uint8Array(32).fill(0xff)]) {
    const b = baby();
    const p = parent();
    toParent(b, p);
    p.endpoint.pair('123456');
    const pair = JSON.parse(take(p.out));
    assert.deepEqual(kinds(b.endpoint.receive(JSON.stringify({ ...pair, y: toBase64(share) }))), ['error']);
    assert.equal(b.out.length, 0, 'no pairReply for a bad share');

    const c = baby();
    const q = parent();
    toParent(c, q);
    q.endpoint.pair('123456');
    toBaby(q, c);
    const reply = JSON.parse(take(c.out));
    assert.deepEqual(kinds(q.endpoint.receive(JSON.stringify({ ...reply, y: toBase64(share) }))), ['error']);
    assert.equal(q.out.length, 0);
  }
});

test('malformed messages close the connection', () => {
  for (const raw of [
    'not json',
    '[]',
    '{"type":"pair","v":2,"pid":"x y","nonce":"AAAA","y":"AAAA"}',
    '{"type":"pair","v":2,"pid":"abc","nonce":"AAAA","y":"AAAA"}',
    '{"type":"auth","v":2,"pid":"abc"}',
  ]) {
    assert.deepEqual(kinds(baby().endpoint.receive(raw)), ['error'], raw);
  }
  assert.deepEqual(kinds(parent().endpoint.receive('{"type":"welcome","v":2,"id":"../x","nonce":"AAAA"}')), ['error']);
});

test('version mismatches are reported on both sides', () => {
  // A version 1 parent answers the welcome with a join: the baby unit says which version it speaks.
  const b = baby();
  const welcome = JSON.parse(take(b.out));
  assert.equal(welcome.v, PROTOCOL_VERSION);
  assert.equal(typeof welcome.nonce, 'string', 'version 1 parents need a nonce to answer at all');
  assert.deepEqual(b.endpoint.receive(JSON.stringify({ type: 'join', proof: 'ab'.repeat(32) })), [
    { kind: 'outdated', peerVersion: 1 },
  ]);
  assert.deepEqual(JSON.parse(take(b.out)), { type: 'version', v: PROTOCOL_VERSION });

  // A future parent.
  const c = baby();
  take(c.out);
  assert.deepEqual(c.endpoint.receive(JSON.stringify({ type: 'pair', v: 3 })), [{ kind: 'outdated', peerVersion: 3 }]);

  // A version 1 baby unit (welcome without v) and a future one.
  assert.deepEqual(parent().endpoint.receive(JSON.stringify({ type: 'welcome', id: MONITOR_ID, nonce: '1234567890123456' })), [
    { kind: 'version', peerVersion: 1 },
  ]);
  assert.deepEqual(parent().endpoint.receive(JSON.stringify({ type: 'welcome', v: 3, id: MONITOR_ID })), [
    { kind: 'version', peerVersion: 3 },
  ]);
  // A baby unit that answers our first message with `version`.
  const p = parent();
  p.endpoint.receive(take(baby().out));
  p.endpoint.pair('123456');
  assert.deepEqual(p.endpoint.receive(JSON.stringify({ type: 'version', v: 3 })), [{ kind: 'version', peerVersion: 3 }]);
});

test('code attempts back off per source and are capped overall; paired parents are never blocked', () => {
  let now = 1_000_000;
  const limiter = new PairingLimiter(() => now);
  const attempt = (host: string, code = '000000') => {
    const b = baby({ limiter, host, code: '123456' });
    const p = parent();
    toParent(b, p);
    p.endpoint.pair(code);
    toBaby(p, b);
    return toParent(b, p);
  };

  assert.deepEqual(attempt('10.0.0.2'), [{ kind: 'wrongCode' }]);
  // Right away again from the same address: wait 1 s.
  const waited = attempt('10.0.0.2');
  assert.equal(waited.length, 1);
  assert.equal(waited[0].kind, 'wait');
  now += 1_000;
  assert.deepEqual(attempt('10.0.0.2'), [{ kind: 'wrongCode' }]);
  assert.ok(limiter.check('10.0.0.2') >= 1_999);
  // Other addresses can try, up to 5 failures per 10 minutes in total.
  assert.deepEqual(attempt('10.0.0.3'), [{ kind: 'wrongCode' }]);
  assert.deepEqual(attempt('10.0.0.4'), [{ kind: 'wrongCode' }]);
  assert.deepEqual(attempt('10.0.0.5'), [{ kind: 'wrongCode' }]);
  const blocked = attempt('10.0.0.6', '123456');
  assert.equal(blocked[0].kind, 'wait', 'even the right code waits once the cap is reached');

  // A parent with a pairing key still connects.
  const keys = new Map<string, Uint8Array>();
  const key = random(32);
  keys.set(PARENT_ID, key);
  const b = baby({ keys, limiter, host: '10.0.0.2' });
  const p = parent();
  toParent(b, p);
  p.endpoint.auth(key);
  assert.deepEqual(kinds(toBaby(p, b)), ['open']);

  // After the window the right code works again; a new code resets everything at once.
  now += 10 * 60_000;
  assert.equal(attempt('10.0.0.6', '123456').length, 0);
  limiter.reset();
  assert.equal(limiter.check('10.0.0.2'), 0);
});

test('the daily cap holds even when attempts are spread out', () => {
  let now = 0;
  const limiter = new PairingLimiter(() => now);
  for (let i = 0; i < 20; i++) {
    assert.equal(limiter.check(`10.0.1.${i}`), 0, `attempt ${i}`);
    limiter.begin(`10.0.1.${i}`);
    now += 11 * 60_000;
  }
  assert.ok(limiter.check('10.0.2.1') > 0);
});

test('parent credentials: the stored key first, then the typed code', () => {
  const key = random(32);
  assert.deepEqual(nextParentStep({ key, keyRejected: false, typedCode: null }), { kind: 'auth', key });
  assert.deepEqual(nextParentStep({ key, keyRejected: true, typedCode: null }), { kind: 'ask' });
  assert.deepEqual(nextParentStep({ key: null, keyRejected: false, typedCode: '222222' }), {
    kind: 'pair',
    code: '222222',
  });
});

test('updating from version 1 starts with a new code: nothing version 1 saved is taken over', () => {
  // Version 1 kept its codes in AsyncStorage; none of them reaches the new secrets.
  const monitor = loadMonitorSecrets(null, () => '000000', () => GEN);
  assert.deepEqual(monitor, { secrets: { code: '000000', parentKeys: {}, pairings: 0, generation: GEN }, changed: true });
  const loaded = loadParentSecrets(null, () => PARENT_ID);
  assert.deepEqual(loaded, { secrets: { parentId: PARENT_ID, monitorKeys: {} }, changed: true });
  assert.equal(new ParentCredentials(loaded.secrets, () => {}).hasAny(), false);

  // Pairing with the new code, then loading again: only the key is kept.
  let savedParent: unknown = null;
  const parentCredentials = new ParentCredentials(loaded.secrets, (secrets) => (savedParent = secrets));
  const monitorCredentials = new MonitorCredentials(monitor.secrets, () => true);
  const b = baby({ code: monitorCredentials.code });
  const p = parent(parentCredentials.parentId);
  const [welcome] = toParent(b, p);
  if (welcome.kind !== 'welcome') throw new Error();
  p.endpoint.pair('000000');
  toBaby(p, b);
  toParent(b, p);
  const [paired] = toBaby(p, b);
  if (paired.kind !== 'paired') throw new Error();
  monitorCredentials.saveParentKey(paired.parentId, paired.pairingKey);
  b.out.push(b.endpoint.seal('{"type":"hello","addresses":[]}'));
  const [parentPaired] = toParent(b, p);
  if (parentPaired.kind !== 'paired') throw new Error();
  parentCredentials.savePairing(welcome.monitorId, parentPaired.pairingKey);
  assert.deepEqual(parentCredentials.key(MONITOR_ID), paired.pairingKey);
  assert.equal(monitorCredentials.pairedCount, 1);

  const again = loadParentSecrets(JSON.stringify(savedParent), () => 'other');
  assert.equal(again.changed, false);
  assert.equal(again.secrets.parentId, PARENT_ID);
  assert.deepEqual(Object.keys(again.secrets.monitorKeys), [MONITOR_ID]);
});

test('a wrong code, and unauthenticated messages, never delete a stored key', () => {
  const credentials = new ParentCredentials({ parentId: PARENT_ID, monitorKeys: {} }, () => {});
  const key = random(32);
  credentials.savePairing(MONITOR_ID, key);
  // The baby unit has a different code now (or a fake one answered): the run fails.
  const b = baby({ code: '999999' });
  const p = parent();
  toParent(b, p);
  p.endpoint.pair('424242');
  toBaby(p, b);
  assert.deepEqual(toParent(b, p), [{ kind: 'wrongCode' }]);
  // pairRequired, wait and version messages likewise change nothing stored (no API to do so).
  assert.deepEqual(credentials.key(MONITOR_ID), key);
});

test('ids that name inherited properties find nothing', () => {
  const monitor = new MonitorCredentials({ code: '123456', parentKeys: {}, pairings: 0, generation: GEN }, () => true);
  const parentCredentials = new ParentCredentials({ parentId: PARENT_ID, monitorKeys: {} }, () => {});
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(monitor.parentKey(id), null, id);
    assert.equal(parentCredentials.key(id), null, id);
  }
});

test('a new code on the baby unit forgets every parent', () => {
  const credentials = new MonitorCredentials({ code: '123456', parentKeys: {}, pairings: 0, generation: GEN }, () => true);
  credentials.saveParentKey(PARENT_ID, random(32));
  assert.ok(credentials.parentKey(PARENT_ID));
  assert.equal(credentials.setCode('654321', GEN2), true);
  assert.equal(credentials.parentKey(PARENT_ID), null);
  assert.equal(credentials.code, '654321');
  assert.equal(credentials.pairedCount, 0);
});

test('a new code that could not be saved changes nothing', () => {
  let keychainWorks = true;
  const credentials = new MonitorCredentials({ code: '123456', parentKeys: {}, pairings: 0, generation: GEN }, () => keychainWorks);
  const key = random(32);
  credentials.saveParentKey(PARENT_ID, key);
  keychainWorks = false;
  // Otherwise the new code would hold only until the next restart, and every old parent come back.
  assert.equal(credentials.setCode('654321', GEN2), false);
  assert.equal(credentials.code, '123456');
  assert.deepEqual(credentials.parentKey(PARENT_ID), key);
});

test('stored pairings are capped, oldest out first', () => {
  const credentials = new MonitorCredentials({ code: '123456', parentKeys: {}, pairings: 0, generation: GEN }, () => true);
  for (let i = 0; i < 20; i++) credentials.saveParentKey(`parent${i}`, random(32));
  assert.equal(credentials.parentKey('parent3'), null);
  assert.ok(credentials.parentKey('parent4'));
  assert.ok(credentials.parentKey('parent19'));
});

test('stored secrets that are malformed are ignored, not trusted', () => {
  assert.equal(loadMonitorSecrets('{"code":"12"}', () => '555555', () => GEN).secrets.code, '555555');
  const parentSecrets = loadParentSecrets(
    JSON.stringify({ parentId: PARENT_ID, monitorKeys: { a: 'short', b: toBase64(random(32)) }, legacyCodes: { c: '123456' } }),
    () => 'unused',
  ).secrets;
  assert.deepEqual(Object.keys(parentSecrets.monitorKeys), ['b']);
  assert.equal('legacyCodes' in parentSecrets, false);
});

test('a pairing that started before a new code cannot finish after it', () => {
  let code = '123456';
  const out: string[] = [];
  const endpoint = new MonitorEndpoint({
    random,
    monitorId: MONITOR_ID,
    host: '192.168.1.20',
    send: (line) => out.push(line),
    code: () => code,
    parentKey: () => null,
    limiter: new PairingLimiter(),
  });
  endpoint.welcome();
  const b: Baby = { endpoint, out, keys: new Map(), limiter: new PairingLimiter() };
  const p = parent();
  toParent(b, p);
  p.endpoint.pair('123456');
  toBaby(p, b);
  toParent(b, p);
  // The owner creates a new code while the parent's confirmation is on its way.
  code = '654321';
  assert.deepEqual(toBaby(p, b), [{ kind: 'error', reason: 'code changed' }]);
});

test('every pairing counts, including one that replaces a key or pushes out the oldest', () => {
  const credentials = new MonitorCredentials({ code: '123456', parentKeys: {}, pairings: 0, generation: GEN }, () => true);
  credentials.saveParentKey(PARENT_ID, random(32));
  credentials.saveParentKey('bb'.repeat(16), random(32));
  assert.equal(credentials.pairings, 2);
  // Someone who saw the code pairs under the first parent's id: the key count stays, the pairing count doesn't.
  credentials.saveParentKey(PARENT_ID, random(32));
  assert.equal(credentials.pairedCount, 2);
  assert.equal(credentials.pairings, 3);
  for (let i = 0; i < 20; i++) credentials.saveParentKey(`parent${i}`, random(32));
  assert.equal(credentials.pairedCount, 16);
  assert.equal(credentials.pairings, 23);
  // A new code starts a new generation from zero.
  assert.equal(credentials.setCode('654321', GEN2), true);
  assert.equal(credentials.pairings, 0);
  assert.equal(credentials.generation, GEN2);
});

test('stored secrets without a pairing count or generation get them', () => {
  const stored = JSON.stringify({ code: '123456', parentKeys: { [PARENT_ID]: toBase64(random(32)) } });
  const loaded = loadMonitorSecrets(stored, () => 'unused', () => GEN);
  assert.equal(loaded.changed, true);
  assert.equal(loaded.secrets.pairings, 1);
  assert.equal(loaded.secrets.generation, GEN);
  const again = loadMonitorSecrets(JSON.stringify(loaded.secrets), () => 'unused', () => GEN2);
  assert.equal(again.changed, false);
  assert.equal(again.secrets.generation, GEN);
});
