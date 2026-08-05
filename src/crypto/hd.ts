/**
 * HD wallet derivation (Octra's custom scheme).
 * Ported from crypto_utils.hpp (derive_hd_seed).
 *
 * Octra's HD derivation uses HMAC-SHA-512 with key="Octra seed":
 *
 *   hd_version=2, index=0 (default):
 *     HMAC-SHA512(key="Octra seed", data=master_seed)[0:32]
 *
 *   hd_version=2, index>0:
 *     data = master_seed || uint32_le(index)
 *     HMAC-SHA512(key="Octra seed", data)[0:32]
 *
 *   hd_version=1, index=0 (legacy):
 *     master_seed[0:32]
 *
 * Output: 32-byte seed suitable for Ed25519 keypair generation.
 */
import { sha512, sha256 } from './sha256';

/**
 * Manual HMAC-SHA-512 implementation (matches OpenSSL HMAC(EVP_sha512(), ...)).
 * Used because @noble/hashes doesn't export a simple HMAC-SHA512 function.
 */
function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockLen = 128; // SHA-512 block size
  // Normalize key: hash if too long, pad if too short
  let k = key;
  if (k.length > blockLen) k = sha512(k);
  if (k.length < blockLen) {
    const padded = new Uint8Array(blockLen);
    padded.set(k);
    k = padded;
  }
  // Inner and outer pads
  const ipad = new Uint8Array(blockLen);
  const opad = new Uint8Array(blockLen);
  for (let i = 0; i < blockLen; i++) {
    ipad[i] = k[i]! ^ 0x36;
    opad[i] = k[i]! ^ 0x5c;
  }
  // Inner hash: SHA-512(ipad || data)
  const inner = new Uint8Array(blockLen + data.length);
  inner.set(ipad, 0);
  inner.set(data, blockLen);
  const innerHash = sha512(inner);
  // Outer hash: SHA-512(opad || innerHash)
  const outer = new Uint8Array(blockLen + innerHash.length);
  outer.set(opad, 0);
  outer.set(innerHash, blockLen);
  return sha512(outer);
}

/**
 * Derive an HD account seed (32 bytes) from a BIP39 master seed.
 *
 * @param masterSeed 64-byte BIP39 seed (from mnemonic_to_seed)
 * @param accountIndex HD account index (0 = first account)
 * @param hdVersion 1 = legacy (master_seed[0:32]), 2 = current (HMAC-SHA512)
 *
 * For hd_version=2, index=0:
 *   HMAC-SHA512(key="Octra seed", data=master_seed)[0:32]
 *
 * For hd_version=2, index>0:
 *   data = master_seed || uint32_le(index)
 *   HMAC-SHA512(key="Octra seed", data)[0:32]
 */
export function deriveHdSeed(
  masterSeed: Uint8Array,
  accountIndex: number = 0,
  hdVersion: number = 2,
): Uint8Array {
  if (masterSeed.length !== 64) {
    throw new Error(`deriveHdSeed: master seed must be 64 bytes, got ${masterSeed.length}`);
  }
  if (accountIndex < 0 || !Number.isInteger(accountIndex)) {
    throw new Error(`deriveHdSeed: accountIndex must be a non-negative integer`);
  }

  const octraKey = new TextEncoder().encode('Octra seed');

  if (hdVersion === 1 && accountIndex === 0) {
    // Legacy: just use first 32 bytes of master seed
    return masterSeed.subarray(0, 32).slice();
  } else if (hdVersion === 2 && accountIndex === 0) {
    // Current default: HMAC-SHA512("Octra seed", master_seed)[0:32]
    const mac = hmacSha512(octraKey, masterSeed);
    return mac.subarray(0, 32).slice();
  } else {
    // For index > 0: append uint32_le(index) to master_seed
    const data = new Uint8Array(68);
    data.set(masterSeed, 0);
    data[64] = accountIndex & 0xff;
    data[65] = (accountIndex >> 8) & 0xff;
    data[66] = (accountIndex >> 16) & 0xff;
    data[67] = (accountIndex >> 24) & 0xff;
    const mac = hmacSha512(octraKey, data);
    return mac.subarray(0, 32).slice();
  }
}

/**
 * Derive the master "wallet secret" from a BIP39 seed (used as private key seed).
 * This is just the first 32 bytes of the BIP39 seed.
 */
export function deriveMasterFromBip39Seed(bip39Seed: Uint8Array): Uint8Array {
  if (bip39Seed.length !== 64) {
    throw new Error(`deriveMasterFromBip39Seed: seed must be 64 bytes`);
  }
  return bip39Seed.subarray(0, 32).slice();
}

/** Derive a sub-key for a specific purpose (e.g., PVAC, stealth scanner). */
export function deriveSubKey(parentSeed: Uint8Array, purpose: string): Uint8Array {
  const tagBytes = new TextEncoder().encode(`octra-sub/${purpose}`);
  const combined = new Uint8Array(parentSeed.length + tagBytes.length);
  combined.set(parentSeed, 0);
  combined.set(tagBytes, parentSeed.length);
  return sha256(combined);
}

export { sha256, sha512 };
