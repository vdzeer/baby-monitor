/**
 * Byte helpers for the pairing protocol. Plain TypeScript with no React Native imports, so the
 * protocol runs under Node for the tests (`npm test`) and in Hermes, which has no Buffer and
 * may lack TextDecoder.
 */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** CPace `prepend_len`: the LEB128 length, then the bytes. */
export function prependLen(data: Uint8Array): Uint8Array {
  const length: number[] = [];
  let n = data.length;
  do {
    length.push(n < 128 ? n : (n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  } while (n > 0);
  return concat(Uint8Array.from(length), data);
}

/** CPace `lv_cat`: length-prefixed concatenation, so no two different inputs encode the same. */
export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts.map(prependLen));
}

/** Compares in time that depends only on the lengths, not on where the bytes differ. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    // A lone surrogate becomes U+FFFD, as TextEncoder does.
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** Strict UTF-8 decoding: throws on malformed input instead of guessing. */
export function fromUtf8(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i];
    let code: number;
    let extra: number;
    let min: number;
    if (first < 0x80) {
      code = first;
      extra = 0;
      min = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      code = first & 0x1f;
      extra = 1;
      min = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      code = first & 0x0f;
      extra = 2;
      min = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code = first & 0x07;
      extra = 3;
      min = 0x10000;
    } else {
      throw new Error('invalid UTF-8');
    }
    for (let k = 1; k <= extra; k++) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) throw new Error('invalid UTF-8');
      code = (code << 6) | (next & 0x3f);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('invalid UTF-8');
    text += String.fromCodePoint(code);
    i += extra + 1;
  }
  return text;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES: Record<string, number> = Object.fromEntries([...BASE64].map((char, i) => [char, i]));

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
  }
  return out;
}

/** Standard padded base64; anything else throws, so a peer can't smuggle in alternate encodings. */
export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error('invalid base64');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const char = text[i + k];
      const isPadding = char === '=' && i + 4 === text.length && k >= 4 - padding;
      const value = isPadding ? 0 : BASE64_VALUES[char];
      if (value === undefined) throw new Error('invalid base64');
      n = (n << 6) | value;
    }
    const chunk = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    for (let k = 0; k < 3 && o < out.length; k++) out[o++] = chunk[k];
    // Non-canonical padding bits would give two encodings for the same bytes.
    if (i + 4 === text.length && ((padding === 1 && (n & 0xff) !== 0) || (padding === 2 && (n & 0xffff) !== 0))) {
      throw new Error('invalid base64');
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
