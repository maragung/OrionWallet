/**
 * Base64 encode/decode utilities (URL-safe not used; standard alphabet).
 * Ported from crypto_utils.hpp (base64_encode / base64_decode).
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64_CHARS.length; i++) m[B64_CHARS[i]!] = i;
  return m;
})();

/** Encode a Uint8Array to a base64 string (with `=` padding). */
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 3 <= len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out += B64_CHARS[b0 >> 2]!;
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    out += B64_CHARS[b2 & 0x3f]!;
  }
  const remaining = len - i;
  if (remaining === 1) {
    const b0 = bytes[i]!;
    out += B64_CHARS[b0 >> 2]!;
    out += B64_CHARS[(b0 & 0x03) << 4]!;
    out += '==';
  } else if (remaining === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out += B64_CHARS[b0 >> 2]!;
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += B64_CHARS[(b1 & 0x0f) << 2]!;
    out += '=';
  }
  return out;
}

/** Decode a base64 string to a Uint8Array. Tolerates whitespace; rejects malformed padding. */
export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  // Validate length & padding
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) {
    throw new Error('base64Decode: invalid length (must be multiple of 4)');
  }
  let padCount = 0;
  if (clean[clean.length - 1] === '=') padCount++;
  if (clean[clean.length - 2] === '=') padCount++;
  const outLen = (clean.length / 4) * 3 - padCount;
  const out = new Uint8Array(outLen);
  let outIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean[i]!];
    const c1 = B64_LOOKUP[clean[i + 1]!];
    const c2 = clean[i + 2] === '=' ? 0 : B64_LOOKUP[clean[i + 2]!];
    const c3 = clean[i + 3] === '=' ? 0 : B64_LOOKUP[clean[i + 3]!];
    if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) {
      throw new Error(`base64Decode: invalid char at position ${i}`);
    }
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIdx < outLen) out[outIdx++] = (triplet >> 16) & 0xff;
    if (outIdx < outLen) out[outIdx++] = (triplet >> 8) & 0xff;
    if (outIdx < outLen) out[outIdx++] = triplet & 0xff;
  }
  return out;
}
