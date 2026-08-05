/**
 * BIP39 mnemonic implementation (12/15/18/21/24 words).
 * Ported from crypto_utils.hpp (generate_mnemonic_12, validate_mnemonic,
 * mnemonic_to_seed) and lib/bip39_wordlist.hpp.
 *
 * Octra uses the standard BIP39 wordlist (2048 words). Mnemonic-to-seed
 * uses PBKDF2-HMAC-SHA-512 with 2048 iterations and the "mnemonic" + optional
 * passphrase as the salt — exactly per BIP39 spec.
 *
 * For checksum: SHA-256 of entropy, take first ENT/32 bits as checksum.
 */
import { sha256 } from './sha256';
import { randomBytes } from './random';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2';
import { sha512 as nobleSha512 } from '@noble/hashes/sha512';
import { BIP39_WORDLIST } from './bip39-wordlist';

export type MnemonicStrength = 128 | 160 | 192 | 224 | 256;

const STRENGTH_TO_WORDS: Record<MnemonicStrength, number> = {
  128: 12,
  160: 15,
  192: 18,
  224: 21,
  256: 24,
};

/** Validate the strength value. */
function assertStrength(s: number): asserts s is MnemonicStrength {
  if (!(s in STRENGTH_TO_WORDS)) {
    throw new Error(`Invalid mnemonic strength: ${s}. Must be 128, 160, 192, 224, or 256.`);
  }
}

/** Convert an 11-bit index (0..2047) to its BIP39 word. */
export function wordAtIndex(idx: number): string {
  if (idx < 0 || idx >= 2048) throw new RangeError(`wordAtIndex: ${idx} out of range`);
  return BIP39_WORDLIST[idx]!;
}

/** Convert a word to its 11-bit index. Returns -1 if not found. */
export function indexOfWord(word: string): number {
  return BIP39_WORDLIST.indexOf(word.toLowerCase());
}

/**
 * Generate a mnemonic from given entropy bytes.
 * @param entropyLengthBits 128/160/192/224/256
 */
export function entropyToMnemonic(entropy: Uint8Array, strength: MnemonicStrength = 128): string {
  assertStrength(strength);
  if (entropy.length * 8 !== strength) {
    throw new Error(
      `entropyToMnemonic: entropy must be ${strength / 8} bytes for strength ${strength}, got ${entropy.length}`,
    );
  }
  // Compute checksum = first (strength/32) bits of SHA-256(entropy)
  const hash = sha256(entropy);
  const checksumBits = strength / 32;
  const totalBits = strength + checksumBits;
  const wordCount = totalBits / 11;

  // Combine entropy + checksum bits into a big bit array
  const allBits: number[] = [];
  for (let i = 0; i < entropy.length; i++) {
    const b = entropy[i]!;
    for (let j = 7; j >= 0; j--) allBits.push((b >> j) & 1);
  }
  for (let i = 0; i < checksumBits; i++) {
    allBits.push((hash[i >>> 3]! >> (7 - (i & 7))) & 1);
  }

  // Group into 11-bit indices
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    let idx = 0;
    for (let j = 0; j < 11; j++) {
      idx = (idx << 1) | allBits[i * 11 + j]!;
    }
    words.push(wordAtIndex(idx));
  }
  return words.join(' ');
}

/** Generate a 12-word mnemonic (the Octra default). */
export function generateMnemonic12(): string {
  return entropyToMnemonic(randomBytes(16), 128);
}

/** Generate a 24-word mnemonic. */
export function generateMnemonic24(): string {
  return entropyToMnemonic(randomBytes(32), 256);
}

/** Generate a mnemonic of any supported strength. */
export function generateMnemonic(strength: MnemonicStrength = 128): string {
  assertStrength(strength);
  return entropyToMnemonic(randomBytes(strength / 8), strength);
}

/**
 * Validate a BIP39 mnemonic (length, wordlist, checksum).
 * Returns true iff valid.
 */
export function validateMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  const wc = words.length;
  if (![12, 15, 18, 21, 24].includes(wc)) return false;
  // Entropy bits = wc * 32 / 3; checksum bits = wc / 3
  const entBits = (wc * 32) / 3; // 128, 160, 192, 224, 256 for wc=12,15,18,21,24
  const csBits = wc / 3;

  // Convert words back to bit array
  const bits: number[] = [];
  for (const w of words) {
    const idx = indexOfWord(w);
    if (idx < 0) return false;
    for (let j = 10; j >= 0; j--) bits.push((idx >> j) & 1);
  }
  // Extract entropy bits
  const entropyBytes = new Uint8Array(entBits / 8);
  for (let i = 0; i < entBits; i++) {
    const byteIdx = i >>> 3;
    const bitIdx = 7 - (i & 7);
    entropyBytes[byteIdx]! |= bits[i]! << bitIdx;
  }
  // Recompute checksum
  const hash = sha256(entropyBytes);
  for (let i = 0; i < csBits; i++) {
    const expected = (hash[i >>> 3]! >> (7 - (i & 7))) & 1;
    if (bits[entBits + i] !== expected) return false;
  }
  return true;
}

/**
 * Convert a mnemonic + passphrase to a 64-byte BIP39 seed via PBKDF2-HMAC-SHA-512.
 * Salt: "mnemonic" + passphrase. Iterations: 2048. Output: 64 bytes.
 *
 * The original C++ uses OpenSSL PKCS5_PBKDF2_HMAC with SHA-512.
 * Here we use WebCrypto subtle.deriveBits for native performance.
 */
export async function mnemonicToSeed(
  mnemonic: string,
  passphrase: string = '',
): Promise<Uint8Array> {
  const normalizedMnemonic = mnemonic.trim().split(/\s+/).join(' ');
  const encoder = new TextEncoder();
  // WebCrypto is only available in a secure context (HTTPS/localhost). Over
  // plain HTTP, crypto.subtle is undefined and importKey would throw
  // "Cannot read properties of undefined (reading 'importKey')". Fall back to
  // the pure-JS noble implementation, which yields identical bytes.
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.subtle === 'undefined' ||
    typeof crypto.subtle.importKey !== 'function'
  ) {
    return mnemonicToSeedSync(mnemonic, passphrase);
  }
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(normalizedMnemonic),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const salt = encoder.encode('mnemonic' + passphrase);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 2048,
      hash: 'SHA-512',
    },
    keyMaterial,
    512,
  );
  return new Uint8Array(bits);
}

/**
 * Synchronous fallback for mnemonicToSeed using noble/hashes PBKDF2.
 * Use this only in environments where WebCrypto is unavailable.
 */
export function mnemonicToSeedSync(mnemonic: string, passphrase: string = ''): Uint8Array {
  const normalizedMnemonic = mnemonic.trim().split(/\s+/).join(' ');
  const encoder = new TextEncoder();
  return noblePbkdf2(
    nobleSha512,
    encoder.encode(normalizedMnemonic),
    encoder.encode('mnemonic' + passphrase),
    {
      c: 2048,
      dkLen: 64,
    },
  );
}
