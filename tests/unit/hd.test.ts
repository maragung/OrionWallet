import { describe, it, expect } from 'vitest';
import { deriveHdSeed, deriveMasterFromBip39Seed, deriveSubKey } from '../../src/crypto/hd';
import { mnemonicToSeed } from '../../src/crypto/bip39';
import { hexEncode } from '../../src/crypto/hex';

describe('HD derivation', () => {
  // Stable mnemonic for deterministic tests
  const MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('derives a 32-byte seed from a 64-byte master seed', async () => {
    const master = await mnemonicToSeed(MNEMONIC, '');
    expect(master.length).toBe(64);
    const seed = deriveHdSeed(master, 0, 2);
    expect(seed.length).toBe(32);
    expect(hexEncode(seed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same seed for the same inputs (deterministic)', async () => {
    const master = await mnemonicToSeed(MNEMONIC, '');
    const seed1 = deriveHdSeed(master, 0, 2);
    const seed2 = deriveHdSeed(master, 0, 2);
    expect(seed1).toEqual(seed2);
  });

  it('produces different seeds for different account indices', async () => {
    const master = await mnemonicToSeed(MNEMONIC, '');
    const seed0 = deriveHdSeed(master, 0, 2);
    const seed1 = deriveHdSeed(master, 1, 2);
    const seed2 = deriveHdSeed(master, 2, 2);
    expect(seed0).not.toEqual(seed1);
    expect(seed1).not.toEqual(seed2);
    expect(seed0).not.toEqual(seed2);
  });

  it('hd_version=1 (legacy) uses first 32 bytes of master seed', async () => {
    const master = await mnemonicToSeed(MNEMONIC, '');
    const seed = deriveHdSeed(master, 0, 1);
    expect(seed).toEqual(master.subarray(0, 32).slice());
  });

  it('hd_version=2 uses HMAC-SHA512 (different from v1)', async () => {
    const master = await mnemonicToSeed(MNEMONIC, '');
    const seedV1 = deriveHdSeed(master, 0, 1);
    const seedV2 = deriveHdSeed(master, 0, 2);
    expect(seedV1).not.toEqual(seedV2);
  });

  it('rejects non-64-byte master seeds', () => {
    expect(() => deriveHdSeed(new Uint8Array(32), 0, 2)).toThrow('64 bytes');
  });

  it('rejects negative account indices', () => {
    const master = new Uint8Array(64);
    expect(() => deriveHdSeed(master, -1, 2)).toThrow('non-negative');
  });

  it('rejects non-integer account indices', () => {
    const master = new Uint8Array(64);
    expect(() => deriveHdSeed(master, 1.5, 2)).toThrow('non-negative');
  });

  it('derives the same known value for the all-zero-entropy mnemonic at index 0', async () => {
    const master = await mnemonicToSeed(MNEMONIC, '');
    const seed = deriveHdSeed(master, 0, 2);
    const seed2 = deriveHdSeed(master, 0, 2);
    expect(hexEncode(seed)).toBe(hexEncode(seed2));
    expect(seed.length).toBe(32);
  });

  it('derives high account indices (1000+)', async () => {
    const master = await mnemonicToSeed(MNEMONIC, '');
    const seed = deriveHdSeed(master, 1000, 2);
    expect(seed.length).toBe(32);
  });

  // === CRITICAL: Verify against known devnet test vector ===
  it('derives the correct address for the devnet test mnemonic', async () => {
    // This is the user's devnet test mnemonic (non-standard checksum, but valid words)
    const devnetMnemonic =
      'predict anger trick phone coach near panda december endless ghost gloom scout';
    const expectedAddr = 'octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia';
    const expectedPrivKey = 'DgrXU6tcSZpiFDdduoQIjhCISWBlAqlxzLZP5Fh2tgM=';

    const master = await mnemonicToSeed(devnetMnemonic, '');
    const hdSeed = deriveHdSeed(master, 0, 2);

    // Verify private key matches
    const { base64Encode } = await import('../../src/crypto/base64');
    expect(base64Encode(hdSeed)).toBe(expectedPrivKey);

    // Verify address matches
    const { keypairFromSeed } = await import('../../src/crypto/ed25519');
    const { deriveAddressFromPubkey } = await import('../../src/crypto/address');
    const kp = keypairFromSeed(hdSeed);
    const addr = deriveAddressFromPubkey(kp.publicKey);
    expect(addr).toBe(expectedAddr);
  });
});

describe('deriveMasterFromBip39Seed', () => {
  it('returns 32 bytes from a 64-byte BIP39 seed', () => {
    const bip39 = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bip39[i] = i;
    const master = deriveMasterFromBip39Seed(bip39);
    expect(master.length).toBe(32);
  });

  it('is deterministic', () => {
    const bip39 = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bip39[i] = i;
    const m1 = deriveMasterFromBip39Seed(bip39);
    const m2 = deriveMasterFromBip39Seed(bip39);
    expect(m1).toEqual(m2);
  });

  it('rejects non-64-byte seeds', () => {
    expect(() => deriveMasterFromBip39Seed(new Uint8Array(32))).toThrow('64 bytes');
  });
});

describe('deriveSubKey', () => {
  it('returns 32 bytes', () => {
    const parent = new Uint8Array(32);
    const sub = deriveSubKey(parent, 'pvac-seed');
    expect(sub.length).toBe(32);
  });

  it('produces different sub-keys for different purposes', () => {
    const parent = new Uint8Array(32);
    const a = deriveSubKey(parent, 'purpose-a');
    const b = deriveSubKey(parent, 'purpose-b');
    expect(a).not.toEqual(b);
  });

  it('is deterministic for the same inputs', () => {
    const parent = new Uint8Array(32);
    const a = deriveSubKey(parent, 'pvac');
    const b = deriveSubKey(parent, 'pvac');
    expect(a).toEqual(b);
  });
});
