/**
 * X25519 (Curve25519) ECDH primitives, plus Ed25519↔X25519 key conversion.
 * Ported from crypto_utils.hpp (ed25519_sk_to_curve25519, ed25519_pub_to_curve25519)
 * and lib/stealth.hpp (ecdh_shared_secret).
 *
 * The original C++ uses OpenSSL BIGNUM for Ed25519↔X25519 conversion.
 * We use @noble/curves which provides native conversions:
 *   - edwardsToMontgomeryPriv (Ed25519 secret → X25519 secret)
 *   - edwardsToMontgomeryPub  (Ed25519 public → X25519 public)
 *
 * For ECDH we use @noble/curves' x25519.getPublicKey and x25519.scalarMult,
 * OR TweetNaCl's crypto_scalarmult (matches C++ usage). Both produce
 * identical raw X25519 output.
 *
 * Why not libsodium-wrappers-sumo?
 *   Its ESM build has a packaging issue (imports `./libsodium-sumo.mjs` from
 *   a sibling package which Rollup can't resolve). @noble/curves is a pure
 *   ESM package with no such issues, is faster, and is audited.
 */
import nacl from 'tweetnacl';
import { sha256 } from './sha256';
import { edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';

/**
 * Convert an Ed25519 signing secret key (64 bytes = seed||pub) to an X25519
 * scalar secret key (32 bytes). Required for ECDH on the same key material.
 *
 * NOTE: Only the first 32 bytes (the seed) are used; the public key half
 * is ignored. This matches libsodium's crypto_sign_ed25519_sk_to_curve25519.
 */
export function ed25519SkToX25519(edSecretKey: Uint8Array): Uint8Array {
  if (edSecretKey.length !== 64) {
    throw new Error(`ed25519SkToX25519: secret key must be 64 bytes, got ${edSecretKey.length}`);
  }
  // Extract the seed (first 32 bytes) and convert via noble
  const seed = edSecretKey.subarray(0, 32);
  return edwardsToMontgomeryPriv(seed);
}

/** Async variant (kept for API compatibility with callers that await). */
export async function ed25519SkToX25519Async(edSecretKey: Uint8Array): Promise<Uint8Array> {
  return ed25519SkToX25519(edSecretKey);
}

/**
 * Convert an Ed25519 public key (32 bytes) to an X25519 public key (32 bytes).
 */
export function ed25519PkToX25519(edPublicKey: Uint8Array): Uint8Array {
  if (edPublicKey.length !== 32) {
    throw new Error(`ed25519PkToX25519: public key must be 32 bytes, got ${edPublicKey.length}`);
  }
  return edwardsToMontgomeryPub(edPublicKey);
}

/** Async variant (kept for API compatibility). */
export async function ed25519PkToX25519Async(edPublicKey: Uint8Array): Promise<Uint8Array> {
  return ed25519PkToX25519(edPublicKey);
}

/** Generate a new X25519 keypair (32-byte secret + 32-byte public). */
export function generateX25519Keypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const kp = nacl.box.keyPair();
  return {
    secretKey: new Uint8Array(kp.secretKey),
    publicKey: new Uint8Array(kp.publicKey),
  };
}

/**
 * Compute an X25519 shared secret: mySecret × theirPublic.
 * Returns 32 bytes.
 *
 * Uses @noble/curves for consistency with the key conversion. Cross-checked
 * against TweetNaCl's crypto_scalarmult (identical output for same inputs).
 */
export function scalarMult(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  if (mySecretKey.length !== 32) {
    throw new Error(`scalarMult: secret key must be 32 bytes, got ${mySecretKey.length}`);
  }
  if (theirPublicKey.length !== 32) {
    throw new Error(`scalarMult: public key must be 32 bytes, got ${theirPublicKey.length}`);
  }
  return x25519.scalarMult(mySecretKey, theirPublicKey);
}

/** Compute the X25519 base point: scalarMult_base(secret) → public. */
export function scalarMultBase(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) {
    throw new Error(`scalarMultBase: secret key must be 32 bytes, got ${secretKey.length}`);
  }
  return x25519.scalarMultBase(secretKey);
}

/**
 * ECDH shared secret used by Octra stealth transactions.
 * Mirrors octra::ecdh_shared_secret(myEphSk, theirVPub).
 *
 * Octra further hashes the raw X25519 output with SHA-256 and a domain
 * separator before deriving stealth-tag / claim-key sub-secrets.
 * The raw 32-byte X25519 output is returned here; callers apply domain
 * separation via stealth/ module.
 */
export function ecdhSharedSecret(
  myX25519SecretKey: Uint8Array,
  theirX25519PublicKey: Uint8Array,
): Uint8Array {
  const raw = scalarMult(myX25519SecretKey, theirX25519PublicKey);
  // Apply SHA-256 to match octra::ecdh_shared_secret
  return sha256(raw);
}

/** Backwards-compat: ensureSodium used to be required; now it's a no-op. */
export async function ensureSodium(): Promise<void> {
  // No-op — we no longer use libsodium. Kept for backwards compatibility
  // with any code that calls it.
  return;
}

export { nacl };
