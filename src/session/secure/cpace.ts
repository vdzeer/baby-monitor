/**
 * CPace over ristretto255 with SHA-512 (CPACE-RISTR255-SHA512), as specified in
 * draft-irtf-cfrg-cpace-21, initiator-responder setting. The parent device is the initiator (A),
 * the baby unit the responder (B). Checked against the draft's test vectors in cpace.test.ts.
 *
 * Each run lets a party that doesn't know the code test exactly one guess, online: nothing it
 * sees or sends allows checking further guesses offline.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

import { concat, lvCat, utf8 } from './bytes.ts';

type Point = InstanceType<typeof ristretto255.Point>;

const DSI = utf8('CPaceRistretto255');
const DSI_ISK = utf8('CPaceRistretto255_ISK');
/** SHA-512 input block size (H.s_in_bytes). */
const S_IN_BYTES = 128;
// BigInt() rather than literals, like noble itself, for older Babel/Hermes toolchains.
const ZERO = BigInt(0);
const EIGHT = BigInt(8);

/** `generator_string(DSI, PRS, CI, sid, s_in_bytes)`: zero padding fills the first hash block. */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zpad = Math.max(0, S_IN_BYTES - 1 - lvCat(prs).length - lvCat(DSI).length);
  return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid);
}

/** `G.calculate_generator`: RFC 9496 element derivation of the 64-byte hash. */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Point {
  if (!ristretto255_hasher.deriveToCurve) throw new Error('ristretto255 element derivation is unavailable');
  return ristretto255_hasher.deriveToCurve(sha512(generatorString(prs, ci, sid)));
}

/**
 * `G.sample_scalar`: 32 random bytes with the bits above 252 cleared, read little-endian
 * (the draft's recommended method; every result is below the group order).
 */
export function sampleScalar(random: (length: number) => Uint8Array): bigint {
  for (;;) {
    const bytes = random(32);
    if (bytes.length !== 32) throw new Error('random source returned the wrong length');
    bytes[31] &= 0x0f;
    const scalar = scalarFromBytes(bytes);
    // Zero has probability 2^-252; it would make the share the identity.
    if (scalar !== ZERO) return scalar;
  }
}

export function scalarFromBytes(littleEndian: Uint8Array): bigint {
  let scalar = ZERO;
  for (let i = littleEndian.length - 1; i >= 0; i--) scalar = (scalar << EIGHT) | BigInt(littleEndian[i]);
  return scalar;
}

/** `G.scalar_mult(y, g)`: the encoded share Y = y·g. */
export function scalarMult(y: bigint, g: Point): Uint8Array {
  return g.multiply(y).toBytes();
}

/**
 * `G.scalar_mult_vfy(y, X)`: K = y·decode(X), or null for anything that must abort the run:
 * an invalid or non-canonical encoding, the neutral element, or a neutral result.
 */
export function scalarMultVfy(y: bigint, encoded: Uint8Array): Uint8Array | null {
  let point: Point;
  try {
    point = ristretto255.Point.fromBytes(encoded);
  } catch {
    return null;
  }
  if (point.is0()) return null;
  const k = point.multiply(y);
  return k.is0() ? null : k.toBytes();
}

/** ISK = H(lv_cat(DSI || "_ISK", sid, K) || transcript_ir(Ya, ADa, Yb, ADb)). */
export function intermediateKey(
  sid: Uint8Array,
  k: Uint8Array,
  ya: Uint8Array,
  ada: Uint8Array,
  yb: Uint8Array,
  adb: Uint8Array,
): Uint8Array {
  return sha512(concat(lvCat(DSI_ISK, sid, k), lvCat(ya, ada), lvCat(yb, adb)));
}

/**
 * Explicit key confirmation as suggested in the draft (section 10.4):
 * mac_key = H("CPaceMac" || sid || ISK), and each side tags the message it sent.
 */
export function confirmationTag(sid: Uint8Array, isk: Uint8Array, share: Uint8Array, ad: Uint8Array): Uint8Array {
  const macKey = sha512(concat(utf8('CPaceMac'), sid, isk));
  return hmac(sha512, macKey, lvCat(share, ad));
}
