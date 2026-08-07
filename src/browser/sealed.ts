/**
 * Sealed-circle resource-key derivation + `OCRS1` envelope decryption.
 *
 * Ported from the webcli reference (static/circles.js):
 *   - tagged hashing `h256` (lines 74-85)
 *   - `resourceKeyOfPath` (line 85)
 *   - `deriveReadKey` PBKDF2 params (lines 1114-1130)
 *   - `decryptSealedBytes` envelope format (lines 1144-1170)
 *
 * Crypto primitives are reused from Orion's own audited modules
 * (`src/crypto/aes.ts`, `src/crypto/sha256.ts`) rather than re-implemented, so
 * behaviour matches the rest of the wallet (WebCrypto with a pure-JS noble
 * fallback for non-secure contexts).
 */
import { aesGcmDecrypt, DEFAULT_PBKDF2_ITERATIONS } from '../crypto/aes';
import { sha256 } from '../crypto/sha256';
import { hexEncode } from '../crypto/hex';
import { base64Decode } from '../crypto/base64';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';

/** PBKDF2 iteration count for sealed read keys (webcli circles.js:1121). */
export const SEALED_READ_ITERATIONS = 120_000;
const SEALED_MAGIC = 'OCRS1';
const KEY_LEN = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function readU32be(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

function mergeBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Tagged, length-framed SHA-256, matching webcli `h256Raw` (circles.js:74-81):
 *   sha256( utf8(tag) || 0x00 || for each part: u32be(len) || part )
 */
function h256Hex(tag: string, parts: Uint8Array[]): string {
  let framed = mergeBytes(enc.encode(tag), new Uint8Array([0]));
  for (const part of parts) {
    framed = mergeBytes(framed, u32be(part.length), part);
  }
  return hexEncode(sha256(framed));
}

/**
 * Derive the on-chain resource key for a circle asset path.
 * `h256('octra:circle_resource_key:v1', [circleId, canonicalPath])`.
 */
export function resourceKeyOfPath(circleId: string, canonicalPath: string): string {
  return h256Hex('octra:circle_resource_key:v1', [enc.encode(circleId), enc.encode(canonicalPath)]);
}

/**
 * Derive the raw 32-byte AES-256 read key from a passphrase.
 * PBKDF2-HMAC-SHA-256, salt `octra:circle:sealed_read:v1:{circleId}:{keyId}`,
 * 120k iterations (webcli circles.js:1114-1130).
 *
 * Uses WebCrypto when available (secure context), else the noble fallback —
 * both produce identical bytes.
 */
export async function deriveReadKeyBytes(
  circleId: string,
  keyId: string,
  passphrase: string,
): Promise<Uint8Array> {
  const salt = enc.encode(`octra:circle:sealed_read:v1:${circleId}:${keyId}`);
  const hasSubtle =
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.importKey === 'function';
  if (hasSubtle) {
    const material = await crypto.subtle.importKey(
      'raw',
      toBuf(enc.encode(passphrase)),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: toBuf(salt), iterations: SEALED_READ_ITERATIONS, hash: 'SHA-256' },
      material,
      KEY_LEN * 8,
    );
    return new Uint8Array(bits);
  }
  return noblePbkdf2(nobleSha256, enc.encode(passphrase), salt, {
    c: SEALED_READ_ITERATIONS,
    dkLen: KEY_LEN,
  });
}

/** Sealed asset metadata as returned by the ciphertext RPC. */
export interface SealedAsset {
  ciphertext_b64: string;
  key_id?: string;
  plaintext_hash?: string;
  content_type?: string;
  canonical_path?: string;
  /** Echoed by the node; verified against the requested circle by the caller. */
  circle_id?: string;
}

/**
 * Decrypt an `OCRS1` sealed asset envelope and verify its plaintext hash.
 *
 * Envelope layout (webcli circles.js:1144-1170):
 *   magic[5] = "OCRS1" | nonce[12] | AES-256-GCM ciphertext(+tag)
 * Decrypted frame: u32be(plaintextLen) || plaintext || (padding)
 *
 * Throws on: incomplete metadata, bad magic, short/oversized frame, GCM auth
 * failure (wrong passphrase / corrupted data), or plaintext-hash mismatch.
 */
export async function decryptSealedBytes(
  circleId: string,
  asset: SealedAsset,
  passphrase: string,
): Promise<Uint8Array> {
  if (!asset.key_id || !asset.plaintext_hash) {
    throw new Error('sealed asset metadata incomplete');
  }
  const envelope = base64Decode(asset.ciphertext_b64);
  const magic = dec.decode(envelope.subarray(0, SEALED_MAGIC.length));
  if (magic !== SEALED_MAGIC) {
    throw new Error('invalid sealed envelope');
  }
  const nonce = envelope.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + 12);
  const cipher = envelope.subarray(SEALED_MAGIC.length + 12);
  const keyBytes = await deriveReadKeyBytes(circleId, asset.key_id, passphrase);

  let plainFrame: Uint8Array;
  try {
    plainFrame = await aesGcmDecrypt(cipher, keyBytes, nonce);
  } catch {
    throw new Error('sealed decryption failed (wrong passphrase or corrupted data)');
  }
  if (plainFrame.length < 4) {
    throw new Error('invalid sealed payload');
  }
  const plainSize = readU32be(plainFrame.subarray(0, 4));
  if (plainSize > plainFrame.length - 4) {
    throw new Error('invalid sealed payload length');
  }
  const plaintext = plainFrame.subarray(4, 4 + plainSize);
  const actualHash = hexEncode(sha256(plaintext));
  if (actualHash !== asset.plaintext_hash) {
    throw new Error('plaintext hash mismatch');
  }
  return plaintext;
}

// Keep a reference so the shared iteration constant is obviously intentional
// and not accidentally diverging from the wallet default.
void DEFAULT_PBKDF2_ITERATIONS;

function toBuf(b: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return copy;
}
