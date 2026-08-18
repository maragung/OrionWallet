/**
 * AES-256-GCM + PBKDF2 wallet encryption.
 * Ported from crypto_utils.hpp (wallet_encrypt, wallet_decrypt, derive_key_from_pin).
 *
 * The original C++ uses OpenSSL EVP AES-256-GCM and PKCS5_PBKDF2_HMAC.
 * We use WebCrypto subtle for native performance and audit-grade security.
 *
 * File format (matches C++):
 *   magic[4]    = "OCT1"
 *   version[1]  = 0x01
 *   kdf_iter[4] = PBKDF2 iterations (big-endian uint32)
 *   salt[32]    = PBKDF2 salt
 *   nonce[12]   = AES-GCM IV
 *   ciphertext[*] = encrypted data (WebCrypto AES-GCM appends 16-byte tag at end)
 *   (the 16-byte tag is included in the ciphertext slice, per WebCrypto convention)
 */
import { sha256 } from './sha256';
import { randomBytes } from './random';
import { gcm } from '@noble/ciphers/aes';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

/**
 * Whether the native WebCrypto SubtleCrypto API is available.
 *
 * `crypto.subtle` is ONLY exposed in a secure context (HTTPS or
 * http://localhost). When the app is served over plain HTTP on a public
 * IP/port, `crypto.subtle` is `undefined` and every call throws
 * "Cannot read properties of undefined (reading 'importKey')".
 *
 * In that case we transparently fall back to the audited pure-JS
 * @noble/ciphers (AES-256-GCM) + @noble/hashes (PBKDF2) implementations,
 * which produce byte-identical output to WebCrypto, so wallet blobs stay
 * cross-compatible between secure and insecure contexts.
 */
function hasSubtle(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof (crypto as Crypto).subtle !== 'undefined' &&
    typeof crypto.subtle.importKey === 'function'
  );
}

const WALLET_MAGIC = new Uint8Array([0x4f, 0x43, 0x54, 0x31]); // "OCT1"
const WALLET_VERSION = 1;
const DEFAULT_PBKDF2_ITERATIONS = 600_000; // C++ default: 600000 (configurable)
const SALT_LEN = 32;
const NONCE_LEN = 12;
const KEY_LEN = 32; // AES-256
const HEADER_LEN = 4 + 1 + 4 + SALT_LEN + NONCE_LEN;

/** Derive a 32-byte AES-256 key from PIN + salt via PBKDF2-HMAC-SHA-256. */
export async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toBufferSource(enc.encode(pin)),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toBufferSource(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive the raw 32-byte AES-256 key from PIN + salt via PBKDF2-HMAC-SHA-256,
 * using the pure-JS noble implementation. Used in the non-secure-context
 * fallback path where WebCrypto is unavailable.
 */
function deriveKeyBytesFromPin(
  pin: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Uint8Array {
  const enc = new TextEncoder();
  return noblePbkdf2(nobleSha256, enc.encode(pin), salt, { c: iterations, dkLen: KEY_LEN });
}

/** Encrypt arbitrary plaintext bytes with PIN-derived key. */
export async function walletEncrypt(
  plaintext: Uint8Array,
  pin: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  let ciphertext: Uint8Array;
  if (hasSubtle()) {
    const key = await deriveKeyFromPin(pin, salt, iterations);
    ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toBufferSource(nonce) },
        key,
        toBufferSource(plaintext),
      ),
    );
  } else {
    // Non-secure context fallback (pure JS). Byte-identical to WebCrypto:
    // noble's gcm appends the 16-byte auth tag at the end.
    const keyBytes = deriveKeyBytesFromPin(pin, salt, iterations);
    ciphertext = gcm(keyBytes, nonce).encrypt(plaintext);
  }
  // ciphertext already includes the 16-byte GCM tag at the end (WebCrypto convention)

  // Assemble file format
  const out = new Uint8Array(HEADER_LEN + ciphertext.length);
  let off = 0;
  out.set(WALLET_MAGIC, off);
  off += 4;
  out[off++] = WALLET_VERSION;
  const dv = new DataView(out.buffer, off, 4);
  dv.setUint32(0, iterations, false); // big-endian
  off += 4;
  out.set(salt, off);
  off += SALT_LEN;
  out.set(nonce, off);
  off += NONCE_LEN;
  out.set(ciphertext, off);
  return out;
}

/** Decrypt a wallet blob produced by walletEncrypt. Throws on auth failure. */
export async function walletDecrypt(blob: Uint8Array, pin: string): Promise<Uint8Array> {
  if (blob.length < HEADER_LEN + 16) {
    throw new Error('walletDecrypt: blob too short');
  }
  // Verify magic
  for (let i = 0; i < 4; i++) {
    if (blob[i] !== WALLET_MAGIC[i]) {
      throw new Error('walletDecrypt: invalid magic (not an OCT1 wallet)');
    }
  }
  let off = 4;
  const version = blob[off]!;
  off += 1;
  if (version !== WALLET_VERSION) {
    throw new Error(`walletDecrypt: unsupported version ${version}`);
  }
  const dv = new DataView(blob.buffer, blob.byteOffset + off, 4);
  const iterations = dv.getUint32(0, false);
  off += 4;
  const salt = blob.subarray(off, off + SALT_LEN);
  off += SALT_LEN;
  const nonce = blob.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const ciphertext = blob.subarray(off);

  try {
    if (hasSubtle()) {
      const key = await deriveKeyFromPin(pin, salt, iterations);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toBufferSource(nonce) },
        key,
        toBufferSource(ciphertext),
      );
      return new Uint8Array(plaintext);
    }
    // Non-secure context fallback (pure JS).
    const keyBytes = deriveKeyBytesFromPin(pin, salt, iterations);
    return gcm(keyBytes, nonce).decrypt(ciphertext);
  } catch {
    throw new Error('walletDecrypt: decryption failed (wrong PIN or corrupted data)');
  }
}

/** Encrypt a small amount of data with a raw 32-byte key (used by stealth amount encryption). */
export async function aesGcmEncrypt(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.length !== 32) throw new Error('aesGcmEncrypt: key must be 32 bytes');
  if (nonce.length !== 12) throw new Error('aesGcmEncrypt: nonce must be 12 bytes');
  if (!hasSubtle()) {
    return gcm(keyBytes, nonce, aad).encrypt(plaintext);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const algo: AesGcmParams = { name: 'AES-GCM', iv: toBufferSource(nonce) };
  if (aad) algo.additionalData = toBufferSource(aad);
  return new Uint8Array(await crypto.subtle.encrypt(algo, key, toBufferSource(plaintext)));
}

export async function aesGcmDecrypt(
  ciphertext: Uint8Array,
  keyBytes: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.length !== 32) throw new Error('aesGcmDecrypt: key must be 32 bytes');
  if (nonce.length !== 12) throw new Error('aesGcmDecrypt: nonce must be 12 bytes');
  if (!hasSubtle()) {
    return gcm(keyBytes, nonce, aad).decrypt(ciphertext);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const algo: AesGcmParams = { name: 'AES-GCM', iv: toBufferSource(nonce) };
  if (aad) algo.additionalData = toBufferSource(aad);
  return new Uint8Array(await crypto.subtle.decrypt(algo, key, toBufferSource(ciphertext)));
}

/**
 * A key usable with `aesGcmSeal` / `aesGcmOpen`.
 *
 * A `CryptoKey` may be non-extractable, i.e. no script can ever read its bytes
 * back — only WebCrypto can use it. Raw bytes are the fallback for insecure
 * contexts, where `crypto.subtle` does not exist at all.
 */
export type AesGcmKey = CryptoKey | Uint8Array;

/** Encrypt with an already-generated AES-256-GCM key (no PBKDF2 step). */
export async function aesGcmSeal(
  plaintext: Uint8Array,
  key: AesGcmKey,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  if (key instanceof Uint8Array) return aesGcmEncrypt(plaintext, key, nonce);
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBufferSource(nonce) },
      key,
      toBufferSource(plaintext),
    ),
  );
}

/** Decrypt data produced by `aesGcmSeal`. Throws on auth failure. */
export async function aesGcmOpen(
  ciphertext: Uint8Array,
  key: AesGcmKey,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  if (key instanceof Uint8Array) return aesGcmDecrypt(ciphertext, key, nonce);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(nonce) },
      key,
      toBufferSource(ciphertext),
    ),
  );
}

/**
 * Generate a fresh AES-256-GCM key for sealing short-lived local data.
 *
 * In a secure context the key is NON-EXTRACTABLE: it can be handed to
 * IndexedDB (CryptoKey is structured-cloneable) and used later, but its bytes
 * can never be read out again — not by our code, not by injected script.
 * Without `crypto.subtle` there is no such thing, so raw bytes are returned.
 */
export async function generateAesGcmKey(): Promise<AesGcmKey> {
  if (!hasSubtle()) return randomBytes(KEY_LEN);
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Cast a Uint8Array to BufferSource that WebCrypto accepts.
 * Works around TS lib dom strictness with SharedArrayBuffer.
 */
function toBufferSource(b: Uint8Array): ArrayBuffer {
  // Copy to a fresh ArrayBuffer to guarantee SharedArrayBuffer-free typing.
  // For our use cases (small buffers), the copy overhead is negligible.
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return copy;
}

/**
 * True when WebCrypto is available for key derivation.
 *
 * When false (insecure context: plain http:// on anything other than
 * localhost), the pure-JS PBKDF2 fallback runs on the main thread and is
 * roughly an order of magnitude slower — seconds on desktop, longer on mobile.
 * Callers can use this to warn the user before a slow unlock.
 */
export function isWebCryptoAvailable(): boolean {
  return hasSubtle();
}

export {
  WALLET_MAGIC,
  WALLET_VERSION,
  DEFAULT_PBKDF2_ITERATIONS,
  SALT_LEN,
  NONCE_LEN,
  KEY_LEN,
  HEADER_LEN,
  sha256,
};
