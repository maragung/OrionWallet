/**
 * Octra address derivation & validation.
 * Ported from crypto_utils.hpp (derive_address_from_pubkey).
 *
 * Octra address format:
 *   "oct" + base58(sha256(pubkey)[0:32])  — left-padded with '1' to 44 chars
 *   Total length = 3 + 44 = 47 characters
 *
 * Padding: base58 encoding of 32 bytes can be 43 or 44 chars depending on
 * the leading byte. Octra's C++ validation requires exactly 47 chars, so we
 * left-pad with '1' (the base58 zero-byte) to always reach 44 chars.
 *
 * Validation:
 *   - Length == 47
 *   - Starts with "oct"
 *   - Remaining 44 chars are valid base58
 *   - base58_decode(suffix) is 32 bytes (after stripping leading zero bytes
 *     that were added as padding)
 */
import { sha256 } from './sha256';
import { base58Encode, base58Decode, isValidBase58 } from './base58';

export const ADDRESS_PREFIX = 'oct';
export const ADDRESS_TOTAL_LENGTH = 47;
export const ADDRESS_PAYLOAD_LENGTH = 44; // base58 chars (after left-padding)

/** Derive an Octra address from a 32-byte Ed25519 public key. */
export function deriveAddressFromPubkey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`deriveAddressFromPubkey: pubkey must be 32 bytes, got ${publicKey.length}`);
  }
  const hash = sha256(publicKey); // 32 bytes
  let b58 = base58Encode(hash);
  // Left-pad with '1' (base58 zero-byte) to 44 chars
  if (b58.length > ADDRESS_PAYLOAD_LENGTH) {
    throw new Error(
      `deriveAddressFromPubkey: base58 length ${b58.length} exceeds ${ADDRESS_PAYLOAD_LENGTH} — pubkey hash > 32 bytes?`,
    );
  }
  while (b58.length < ADDRESS_PAYLOAD_LENGTH) b58 = '1' + b58;
  return ADDRESS_PREFIX + b58;
}

/** Validate an Octra address. Returns true iff well-formed. */
export function isValidAddress(addr: string): boolean {
  if (typeof addr !== 'string') return false;
  if (addr.length !== ADDRESS_TOTAL_LENGTH) return false;
  if (!addr.startsWith(ADDRESS_PREFIX)) return false;
  const payload = addr.slice(ADDRESS_PREFIX.length);
  if (!isValidBase58(payload)) return false;
  try {
    // Decode and strip leading zero bytes (padding)
    const decoded = base58Decode(payload);
    // Count leading '1' chars (= leading zero bytes)
    let leading1 = 0;
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] === '1') leading1++;
      else break;
    }
    // The actual payload (after stripping padding) should be 32 bytes
    const actual = decoded.length - leading1;
    return actual === 32;
  } catch {
    return false;
  }
}

/** Extract the 32-byte payload from a valid Octra address. Throws on invalid. */
export function addressToPayload(addr: string): Uint8Array {
  if (!isValidAddress(addr)) {
    throw new Error(`addressToPayload: invalid address '${addr}'`);
  }
  const payload = addr.slice(ADDRESS_PREFIX.length);
  // Strip leading '1' chars (= zero bytes added as padding)
  let leading1 = 0;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] === '1') leading1++;
    else break;
  }
  const decoded = base58Decode(payload);
  return decoded.subarray(leading1);
}

/** Compute the SHA-256 payload hash for an address (without the "oct" prefix). */
export function addressPayloadHash(addr: string): Uint8Array {
  return addressToPayload(addr);
}
