/// <reference types="node" />
/**
 * Checks that the Python stand-in baby unit (tools/fake-baby-unit.py) and the app's protocol code
 * (src/session/secure) agree on the wire: the app's parent side talks to the stand-in over TCP.
 * Start the stand-in first, then run this with Node 22.18+ (it runs TypeScript directly):
 *
 *   .venv/bin/python tools/fake-baby-unit.py --no-audio --motion-every 0 &
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/interop-check.ts [host] [code]
 *
 * host defaults to 127.0.0.1, code to 123456. Stop the stand-in with Ctrl-C (or kill -INT), so it
 * also removes its Bonjour registration.
 */
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import { fromBase64, toBase64 } from '../src/session/secure/bytes.ts';
import { ParentEndpoint, type ParentEvent } from '../src/session/secure/handshake.ts';

const HOST = process.argv[2] ?? '127.0.0.1';
const CODE = process.argv[3] ?? '123456';
const PORT = 47301; // the debug port: never a baby unit in real use
const random = (length: number) => new Uint8Array(randomBytes(length));
const newId = () => randomBytes(16).toString('hex');

class Line {
  socket: Socket;
  lines: string[] = [];
  closed = false;
  private buffer = '';
  private wake: (() => void) | null = null;

  constructor() {
    this.socket = connect(PORT, HOST);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        this.lines.push(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
      }
      this.wake?.();
    });
    const end = () => {
      this.closed = true;
      this.wake?.();
    };
    this.socket.on('close', end);
    this.socket.on('error', end);
  }

  write(line: string) {
    this.socket.write(`${line}\n`);
  }

  /** The next line, or null once the other side closed. */
  async read(timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0 && !this.closed) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the stand-in');
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 100);
      });
    }
    return this.lines.shift() ?? null;
  }

  close() {
    this.socket.destroy();
  }
}

class Parent {
  line = new Line();
  endpoint: ParentEndpoint;
  sent: string[] = [];
  private events: ParentEvent[] = [];

  constructor(parentId: string) {
    this.endpoint = new ParentEndpoint({
      random,
      parentId,
      send: (text) => {
        this.sent.push(text);
        this.line.write(text);
      },
    });
  }

  async next(): Promise<ParentEvent | null> {
    while (this.events.length === 0) {
      const text = await this.line.read();
      if (text === null) return null;
      this.events.push(...this.endpoint.receive(text));
    }
    return this.events.shift() ?? null;
  }

  async expect(kind: ParentEvent['kind']): Promise<ParentEvent> {
    const event = await this.next();
    if (event?.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(event)}`);
    return event;
  }

  /** The app messages a baby unit sends right after the handshake. */
  async expectStreamStart() {
    const types: string[] = [];
    for (let i = 0; i < 5; i++) {
      const event = await this.expect('message');
      if (event.kind !== 'message') throw new Error();
      const message = JSON.parse(event.text);
      types.push(message.type);
      if (message.type === 'offer' && !String(message.sdp).includes('a=fingerprint')) throw new Error('offer without DTLS fingerprint');
    }
    if (types.join() !== 'hello,status,settings,battery,offer') throw new Error(`unexpected messages: ${types.join()}`);
  }
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const parentId = newId();
let pairingKey: Uint8Array | null = null;

await check('pairing with the code (CPace, both confirmations), then encrypted messages', async () => {
  const parent = new Parent(parentId);
  await parent.expect('welcome');
  parent.endpoint.pair(CODE);
  const paired = await parent.expect('paired');
  if (paired.kind !== 'paired') throw new Error();
  pairingKey = paired.pairingKey;
  await parent.expectStreamStart();
  parent.line.close();
});

await check('a later connection authenticates with the pairing key', async () => {
  if (!pairingKey) throw new Error('no key from the pairing');
  const parent = new Parent(parentId);
  await parent.expect('welcome');
  parent.endpoint.auth(pairingKey);
  await parent.expect('open');
  await parent.expectStreamStart();
  // Our answer travels encrypted too; the stand-in must decrypt it.
  parent.line.write(parent.endpoint.seal(JSON.stringify({ type: 'setSettings', settings: { night: 'on' } })));
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (parent.line.closed) throw new Error('the stand-in closed on a valid sealed message');
  parent.line.close();
});

await check('a wrong code fails on the parent side', async () => {
  const parent = new Parent(newId());
  await parent.expect('welcome');
  parent.endpoint.pair(CODE === '000000' ? '111111' : '000000');
  await parent.expect('wrongCode');
  parent.line.close();
});

await check('an unknown key gets pairRequired, then pairing works on the same connection', async () => {
  const parent = new Parent(newId());
  await parent.expect('welcome');
  parent.endpoint.auth(random(32));
  await parent.expect('pairRequired');
  parent.endpoint.pair(CODE);
  await parent.expect('paired');
  parent.line.close();
});

await check('a replayed auth message is not accepted on a new connection', async () => {
  if (!pairingKey) throw new Error('no key from the pairing');
  const first = new Parent(parentId);
  await first.expect('welcome');
  first.endpoint.auth(pairingKey);
  await first.expect('open');
  first.line.close();
  const replay = new Line();
  await replay.read(); // welcome with a fresh nonce
  replay.write(first.sent[0]);
  const answer = JSON.parse((await replay.read()) ?? '{}');
  if (answer.type !== 'pairRequired') throw new Error(`got ${JSON.stringify(answer)}`);
  replay.close();
});

await check('a tampered sealed message closes the connection', async () => {
  if (!pairingKey) throw new Error('no key from the pairing');
  const parent = new Parent(parentId);
  await parent.expect('welcome');
  parent.endpoint.auth(pairingKey);
  await parent.expect('open');
  await parent.expectStreamStart();
  const sealed = JSON.parse(parent.endpoint.seal(JSON.stringify({ type: 'setSettings', settings: { night: 'off' } })));
  const box = fromBase64(sealed.box);
  box[5] ^= 1;
  parent.line.write(JSON.stringify({ type: 'sealed', box: toBase64(box) }));
  while ((await parent.line.read()) !== null);
  if (!parent.line.closed) throw new Error('still open');
});

await check('a version 1 parent is told the version', async () => {
  const line = new Line();
  const welcome = JSON.parse((await line.read()) ?? '{}');
  if (welcome.v !== 2 || typeof welcome.nonce !== 'string') throw new Error(`welcome ${JSON.stringify(welcome)}`);
  line.write(JSON.stringify({ type: 'join', proof: 'ab'.repeat(32) }));
  const reply = JSON.parse((await line.read()) ?? '{}');
  if (reply.type !== 'version' || reply.v !== 2) throw new Error(`got ${JSON.stringify(reply)}`);
  line.close();
});
