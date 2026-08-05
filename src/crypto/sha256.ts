/**
 * SHA-256 / SHA-512 hashing utilities (synchronous noble/hashes-backed).
 * Ported from crypto_utils.hpp (sha256).
 *
 * The original C++ implementation is hand-rolled. Here we delegate to
 * @noble/hashes for sync access (needed by transaction signing) and
 * WebCrypto for async contexts.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { sha512 as nobleSha512 } from '@noble/hashes/sha512';
import { hmac as nobleHmac } from '@noble/hashes/hmac';

/** Synchronous SHA-256 of a Uint8Array → 32-byte digest. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** Synchronous SHA-256 of a UTF-8 string, returned as a lowercase hex string. */
export function sha256Str(s: string): string {
  const bytes = sha256(new TextEncoder().encode(s));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Synchronous SHA-512 of a Uint8Array → 64-byte digest. */
export function sha512(bytes: Uint8Array): Uint8Array {
  return nobleSha512(bytes);
}

/** Asynchronous SHA-256 via WebCrypto (preferred when async is OK). */
export async function sha256Async(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    // Copy to a fresh ArrayBuffer to satisfy BufferSource typing
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return new Uint8Array(digest);
  }
  return nobleSha256(bytes);
}

/** Double SHA-256 (Bitcoin-style): SHA-256(SHA-256(x)). */
export function doubleSha256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

/** HMAC-SHA-256 (synchronous, noble/hashes-based). */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return nobleHmac(nobleSha256, key, data);
}
