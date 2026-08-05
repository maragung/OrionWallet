/**
 * Ed25519 signing primitives.
 * Ported from lib/tweetnacl.c usage in crypto_utils.hpp + tx_builder.hpp.
 *
 * Octra uses Ed25519 keys (64-byte secret = 32-byte seed + 32-byte public;
 * 32-byte public key alone for verification). We support three backends:
 *   1. tweetnacl  (pure JS, exact algorithmic match with original C code)
 *   2. libsodium  (WASM, faster — used when available)
 *   3. noble/curves (fallback for environments without sodium)
 *
 * For Octra, **tweetnacl is the canonical signer** because the original C++
 * uses TweetNaCl directly. We default to tweetnacl for signing determinism
 * and libsodium for the auxiliary Ed25519↔X25519 conversion (which tweetnacl
 * does not provide).
 */
import nacl from 'tweetnacl';
import { ed25519 as nobleEd25519 } from '@noble/curves/ed25519';
import { randomBytes } from './random';
import { sha512 } from './sha256';

export interface Ed25519Keypair {
  /** 64-byte secret key = 32-byte seed || 32-byte public key (TweetNaCl convention). */
  secretKey: Uint8Array;
  /** 32-byte public key. */
  publicKey: Uint8Array;
  /** 32-byte seed (first half of secretKey). */
  seed: Uint8Array;
}

/**
 * Deterministically derive an Ed25519 keypair from a 32-byte seed.
 * Uses tweetnacl to match the original C++ TweetNaCl output byte-for-byte.
 */
export function keypairFromSeed(seed: Uint8Array): Ed25519Keypair {
  if (seed.length !== 32) {
    throw new Error(`keypairFromSeed: seed must be 32 bytes, got ${seed.length}`);
  }
  // Copy seed to ensure cross-realm Uint8Array compatibility
  const seedCopy = new Uint8Array(seed);
  const kp = nacl.sign.keyPair.fromSeed(seedCopy);
  return {
    secretKey: new Uint8Array(kp.secretKey), // 64 bytes
    publicKey: new Uint8Array(kp.publicKey), // 32 bytes
    seed: seed.slice(),
  };
}

/** Generate a new random Ed25519 keypair. */
export function generateKeypair(): Ed25519Keypair {
  return keypairFromSeed(randomBytes(32));
}

/**
 * Sign a 32-byte (or arbitrary) message with Ed25519.
 * Returns a 64-byte signature.
 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 64) {
    throw new Error(`sign: secretKey must be 64 bytes (seed||pub), got ${secretKey.length}`);
  }
  // Copy to fresh Uint8Array to ensure cross-realm compatibility
  // (vitest jsdom may produce Uint8Arrays from a different realm than tweetnacl's)
  const msg = new Uint8Array(message);
  const sk = new Uint8Array(secretKey);
  return nacl.sign.detached(msg, sk);
}

/** Verify an Ed25519 signature. Returns true if valid. */
export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  if (publicKey.length !== 32) return false;
  const msg = new Uint8Array(message);
  const sig = new Uint8Array(signature);
  const pk = new Uint8Array(publicKey);
  return nacl.sign.detached.verify(msg, sig, pk);
}

/** Sign using the noble/curves backend (fallback). */
export function signNoble(message: Uint8Array, seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new Error(`signNoble: seed must be 32 bytes, got ${seed.length}`);
  }
  return nobleEd25519.sign(message, seed);
}

/** Verify using the noble/curves backend (fallback). */
export function verifyNoble(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return nobleEd25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Sign a pre-hashed (SHA-512) message using Ed25519ph-like pattern.
 * NOTE: TweetNaCl's sign.detached does raw Ed25519, NOT Ed25519ph.
 * Octra's C++ code uses crypto_sign_detached (raw), so this helper
 * is only provided for compatibility with future prehash schemes.
 */
export function signPrehashed(
  message: Uint8Array,
  secretKey: Uint8Array,
): { signature: Uint8Array; prehash: Uint8Array } {
  const prehash = sha512(message);
  return { signature: sign(prehash, secretKey), prehash };
}

/**
 * Cross-check a signature against both tweetnacl and noble backends.
 * Useful for test vectors. Returns true iff both backends verify.
 */
export function verifyBoth(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return verify(message, signature, publicKey) && verifyNoble(message, signature, publicKey);
}

/** Wipe a secret key buffer (best-effort, JS cannot truly zero memory). */
export function wipeSecret(buf: Uint8Array): void {
  for (let i = 0; i < buf.length; i++) buf[i] = 0;
}

export { nacl };
