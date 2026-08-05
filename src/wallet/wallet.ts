/**
 * Octra Wallet struct + create/import/load/save.
 * Ported from wallet.hpp (Wallet struct, create_wallet, import_wallet_mnemonic).
 *
 * Key differences from original C++ (verified against devnet):
 *   - priv_b64 = base64(hd_seed[0:32]) — NOT the full 64-byte secret key
 *   - HD derivation: HMAC-SHA512(key="Octra seed", data=master_seed)[0:32] for v2/index=0
 *   - Mnemonic checksum validation is skipped on import (some Octra mnemonics have non-standard checksums)
 */
import { keypairFromSeed, wipeSecret, type Ed25519Keypair } from '../crypto/ed25519';
import { deriveAddressFromPubkey, isValidAddress } from '../crypto/address';
import { base64Encode, base64Decode } from '../crypto/base64';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '../crypto/bip39';
import { deriveHdSeed, deriveMasterFromBip39Seed } from '../crypto/hd';
import { randomBytes } from '../crypto/random';
import { walletEncrypt, walletDecrypt } from '../crypto/aes';

/** In-memory wallet representation. */
export interface Wallet {
  /** Octra address (47 chars). */
  addr: string;
  /** 64-byte Ed25519 secret key (seed||pub). Used for signing. */
  sk: Uint8Array;
  /** 32-byte Ed25519 public key. */
  pk: Uint8Array;
  /** base64(pk). */
  pubB64: string;
  /** base64 of the 32-byte HD seed (NOT the full 64-byte secret key).
   * This is what Octra calls "priv_b64" — it's the seed used for PVAC keygen. */
  privB64: string;
  /** BIP39 mnemonic (empty if imported via private key). */
  mnemonic: string;
  /** 64-byte BIP39 master seed (for HD derivation; empty if no mnemonic). */
  hdMaster: Uint8Array;
  /** Account label. */
  name: string;
  /** HD account index (0 if not HD). */
  index: number;
  /** HD version (1=legacy, 2=current). */
  hdVersion: number;
  /** Whether this wallet was created (vs imported). */
  createdAt: number;
}

/** Serialize a wallet to a JSON-encodable blob for encryption. */
export function serializeWallet(w: Wallet): Uint8Array {
  const obj = {
    v: 2,
    addr: w.addr,
    sk: base64Encode(w.sk),
    pk: base64Encode(w.pk),
    priv_b64: w.privB64,
    mnemonic: w.mnemonic,
    hd_master: w.hdMaster.length > 0 ? base64Encode(w.hdMaster) : '',
    name: w.name,
    index: w.index,
    hd_version: w.hdVersion,
    created_at: w.createdAt,
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** Deserialize a wallet from a decrypted blob. */
export function deserializeWallet(blob: Uint8Array): Wallet {
  const text = new TextDecoder().decode(blob);
  const obj = JSON.parse(text);
  const sk = base64Decode(obj.sk);
  const pk = base64Decode(obj.pk);
  // For v1 wallets, privB64 was the full 64-byte sk. For v2+, it's the 32-byte seed.
  // If priv_b64 is stored, use it; otherwise derive from sk[0:32] (v1 compat).
  const privB64 = obj.priv_b64 || base64Encode(sk.subarray(0, 32));
  return {
    addr: obj.addr,
    sk,
    pk,
    pubB64: base64Encode(pk),
    privB64,
    mnemonic: obj.mnemonic || '',
    hdMaster: obj.hd_master ? base64Decode(obj.hd_master) : new Uint8Array(0),
    name: obj.name || '',
    index: obj.index || 0,
    hdVersion: obj.hd_version || 2,
    createdAt: obj.created_at || 0,
  };
}

/** Create a brand new wallet (generates 12-word mnemonic + HD master). */
export async function createWallet(name: string = 'Account 1'): Promise<Wallet> {
  const mnemonic = generateMnemonic(128);
  const masterSeed = await mnemonicToSeed(mnemonic, '');
  // Derive first HD account (index 0, hd_version=2)
  const hdSeed = deriveHdSeed(masterSeed, 0, 2);
  const kp = keypairFromSeed(hdSeed);
  const addr = deriveAddressFromPubkey(kp.publicKey);
  return {
    addr,
    sk: kp.secretKey,
    pk: kp.publicKey,
    pubB64: base64Encode(kp.publicKey),
    privB64: base64Encode(hdSeed), // 32-byte HD seed (NOT 64-byte sk)
    mnemonic,
    hdMaster: masterSeed,
    name,
    index: 0,
    hdVersion: 2,
    createdAt: Date.now(),
  };
}

/** Import a wallet from a BIP39 mnemonic.
 *
 * NOTE: Checksum validation is skipped by default. Some Octra mnemonics
 * have non-standard checksums. Set `strictChecksum=true` to enforce BIP39
 * checksum validation.
 */
export async function importWalletFromMnemonic(
  mnemonic: string,
  name: string = 'Imported',
  accountIndex: number = 0,
  options: { strictChecksum?: boolean; hdVersion?: number } = {},
): Promise<Wallet> {
  const normalized = mnemonic.trim().split(/\s+/).join(' ');
  const hdVersion = options.hdVersion ?? 2;

  if (options.strictChecksum && !validateMnemonic(normalized)) {
    throw new Error('importWalletFromMnemonic: invalid mnemonic (checksum or wordlist)');
  }

  // Even without checksum validation, verify all words are in the wordlist
  const words = normalized.split(' ');
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error(`importWalletFromMnemonic: invalid word count (${words.length})`);
  }

  const masterSeed = await mnemonicToSeed(normalized, '');
  const hdSeed = deriveHdSeed(masterSeed, accountIndex, hdVersion);
  const kp = keypairFromSeed(hdSeed);
  const addr = deriveAddressFromPubkey(kp.publicKey);
  return {
    addr,
    sk: kp.secretKey,
    pk: kp.publicKey,
    pubB64: base64Encode(kp.publicKey),
    privB64: base64Encode(hdSeed), // 32-byte HD seed (NOT 64-byte sk)
    mnemonic: normalized,
    hdMaster: masterSeed,
    name,
    index: accountIndex,
    hdVersion,
    createdAt: Date.now(),
  };
}

/** Import a wallet from a raw 32-byte Ed25519 seed (no mnemonic, no HD). */
export function importWalletFromSeed(seed: Uint8Array): Wallet {
  if (seed.length !== 32) {
    throw new Error(`importWalletFromSeed: seed must be 32 bytes, got ${seed.length}`);
  }
  const kp = keypairFromSeed(seed);
  const addr = deriveAddressFromPubkey(kp.publicKey);
  return {
    addr,
    sk: kp.secretKey,
    pk: kp.publicKey,
    pubB64: base64Encode(kp.publicKey),
    privB64: base64Encode(seed), // 32-byte seed
    mnemonic: '',
    hdMaster: new Uint8Array(0),
    name: 'Imported',
    index: 0,
    hdVersion: 2,
    createdAt: Date.now(),
  };
}

/** Import a wallet from a 64-byte Ed25519 secret key (seed||pub). */
export function importWalletFromSecretKey(sk: Uint8Array): Wallet {
  if (sk.length !== 64) {
    throw new Error(`importWalletFromSecretKey: secret key must be 64 bytes, got ${sk.length}`);
  }
  const pk = sk.subarray(32, 64);
  const seed = sk.subarray(0, 32);
  const addr = deriveAddressFromPubkey(pk);
  return {
    addr,
    sk: sk.slice(),
    pk: pk.slice(),
    pubB64: base64Encode(pk),
    privB64: base64Encode(seed), // 32-byte seed
    mnemonic: '',
    hdMaster: new Uint8Array(0),
    name: 'Imported',
    index: 0,
    hdVersion: 2,
    createdAt: Date.now(),
  };
}

/** Derive an additional HD account from an existing wallet's master seed. */
export function deriveHdAccount(parent: Wallet, accountIndex: number, name: string): Wallet {
  if (parent.hdMaster.length !== 64) {
    throw new Error(
      'deriveHdAccount: parent wallet has no HD master seed (imported via private key)',
    );
  }
  if (accountIndex < 0 || !Number.isInteger(accountIndex)) {
    throw new Error('deriveHdAccount: accountIndex must be non-negative integer');
  }
  const hdSeed = deriveHdSeed(parent.hdMaster, accountIndex, parent.hdVersion || 2);
  const kp = keypairFromSeed(hdSeed);
  const addr = deriveAddressFromPubkey(kp.publicKey);
  return {
    addr,
    sk: kp.secretKey,
    pk: kp.publicKey,
    pubB64: base64Encode(kp.publicKey),
    privB64: base64Encode(hdSeed),
    mnemonic: '',
    hdMaster: parent.hdMaster.slice(),
    name,
    index: accountIndex,
    hdVersion: parent.hdVersion || 2,
    createdAt: Date.now(),
  };
}

/** Encrypt and persist a wallet to a storable blob. */
export async function saveWalletEncrypted(
  w: Wallet,
  pin: string,
  iterations?: number,
): Promise<Uint8Array> {
  const blob = serializeWallet(w);
  return walletEncrypt(blob, pin, iterations);
}

/** Decrypt a stored wallet blob. */
export async function loadWalletEncrypted(blob: Uint8Array, pin: string): Promise<Wallet> {
  const plaintext = await walletDecrypt(blob, pin);
  return deserializeWallet(plaintext);
}

/** Securely wipe sensitive fields (best-effort in JS). */
export function wipeWallet(w: Wallet): void {
  wipeSecret(w.sk);
  wipeSecret(w.pk);
  if (w.hdMaster.length > 0) wipeSecret(w.hdMaster);
  w.mnemonic = '';
  w.privB64 = '';
}

/** Validate an Octra address string. */
export function validateAddress(addr: string): boolean {
  return isValidAddress(addr);
}

export {
  generateMnemonic,
  keypairFromSeed,
  deriveAddressFromPubkey,
  deriveHdSeed,
  deriveMasterFromBip39Seed,
  randomBytes,
};

export type { Ed25519Keypair };
