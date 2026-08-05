/**
 * Base58 encode/decode (Bitcoin alphabet).
 * Ported from crypto_utils.hpp (base58_encode / base58_decode).
 *
 * Octra addresses use base58: `oct` + 44 base58 chars = 47 chars total.
 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const B58_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]!] = i;
  return m;
})();

/** Encode a Uint8Array to a base58 string. */
export function base58Encode(input: Uint8Array): string {
  if (input.length === 0) return '';
  // Count leading zero bytes -> '1' chars
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  // Allocate result buffer (size estimate: log(256)/log(58) ≈ 1.366)
  const result = new Uint8Array(Math.ceil(((input.length - zeros) * 137) / 100) + 1);
  let resultLen = 0;
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i]!;
    let j = 0;
    for (let k = result.length - 1; k >= 0 && (carry !== 0 || j < resultLen); k--, j++) {
      carry += (result[k]! || 0) * 256;
      result[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    resultLen = j;
  }
  // Convert to string, skipping leading zeros in result
  let out = '';
  let started = false;
  for (let k = 0; k < result.length; k++) {
    const v = result[k]!;
    if (v !== 0) started = true;
    if (started || k === result.length - 1) out += B58_ALPHABET[v]!;
  }
  return B58_ALPHABET[0]!.repeat(zeros) + out;
}

/** Decode a base58 string to a Uint8Array. */
export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  // Count leading '1' chars -> zero bytes
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  // Allocate result
  const result = new Uint8Array((s.length * 733) / 1000 + 1);
  let resultLen = 0;
  for (let i = zeros; i < s.length; i++) {
    const c = s[i]!;
    const v = B58_LOOKUP[c];
    if (v === undefined) {
      throw new Error(`base58Decode: invalid character '${c}' at position ${i}`);
    }
    let carry = v;
    let j = 0;
    for (let k = result.length - 1; k >= 0 && (carry !== 0 || j < resultLen); k--, j++) {
      carry += 58 * (result[k]! || 0);
      result[k] = carry & 0xff;
      carry >>= 8;
    }
    resultLen = j;
  }
  // Skip leading zero-bytes in result, prepend explicit zeros
  let skip = 0;
  while (skip < result.length && result[skip] === 0) skip++;
  const out = new Uint8Array(zeros + (result.length - skip));
  out.fill(0, 0, zeros);
  out.set(result.subarray(skip), zeros);
  return out;
}

/** Validate that a string is a valid base58 string (alphabet only). */
export function isValidBase58(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (B58_LOOKUP[s[i]!] === undefined) return false;
  }
  return true;
}
