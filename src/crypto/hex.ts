/**
 * Hex encode/decode utilities.
 * Ported from crypto_utils.hpp (hex_encode / hex_decode).
 */

const HEX_CHARS = '0123456789abcdef';

const HEX_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < 16; i++) {
    m[HEX_CHARS[i]!] = i;
    m[HEX_CHARS[i]!.toUpperCase()] = i;
  }
  return m;
})();

/** Encode a Uint8Array to a lowercase hex string. */
export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[b >> 4]! + HEX_CHARS[b & 0x0f]!;
  }
  return out;
}

/** Decode a hex string (any case) to a Uint8Array. */
export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hexDecode: odd-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX_LOOKUP[hex[i * 2]!];
    const lo = HEX_LOOKUP[hex[i * 2 + 1]!];
    if (hi === undefined || lo === undefined) {
      throw new Error(`hexDecode: invalid hex char at position ${i * 2}`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}
