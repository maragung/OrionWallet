/**
 * CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
 * Browser implementation backed by WebCrypto getRandomValues.
 *
 * Ported from lib/randombytes.c (originally uses getrandom/BCryptGenRandom).
 */

/** Fill a Uint8Array of the given length with cryptographically-secure random bytes. */
export function randomBytes(length: number): Uint8Array {
  if (length < 0) throw new RangeError('randomBytes: length must be non-negative');
  const out = new Uint8Array(length);
  if (length > 0) {
    // WebCrypto handles up to 65536 bytes per call; chunk larger requests.
    const MAX = 0x10000; // 65536
    if (length <= MAX) {
      crypto.getRandomValues(out);
    } else {
      let offset = 0;
      while (offset < length) {
        const chunk = out.subarray(offset, Math.min(offset + MAX, length));
        crypto.getRandomValues(chunk);
        offset += chunk.length;
      }
    }
  }
  return out;
}

/** Generate a single random 32-byte seed (e.g., for Ed25519 keypair generation). */
export function randomSeed32(): Uint8Array {
  return randomBytes(32);
}

/** Generate a random uint64 in [0, max). Uses rejection sampling for uniformity. */
export function randomUint64(max: bigint): bigint {
  if (max <= 0n) throw new RangeError('randomUint64: max must be positive');
  const mask = (1n << 64n) - 1n;
  // Rejection sampling: draw 8 bytes, interpret as bigint, retry if >= max
  // To avoid heavy loops, use modulo bias-correction with ceil(log2(max)/8)+1 bytes.
  const bits = max.toString(2).length;
  const bytes = Math.ceil(bits / 8) + 1; // extra byte to reduce rejection rate
  while (true) {
    const r = randomBytes(bytes);
    let v = 0n;
    for (let i = 0; i < bytes; i++) v = (v << 8n) | BigInt(r[i]!);
    v &= mask;
    if (v < max) return v;
  }
}
