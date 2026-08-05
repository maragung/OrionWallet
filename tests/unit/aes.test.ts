import { describe, it, expect } from 'vitest';
import {
  walletEncrypt,
  walletDecrypt,
  deriveKeyFromPin,
  aesGcmEncrypt,
  aesGcmDecrypt,
  WALLET_MAGIC,
  HEADER_LEN,
} from '../../src/crypto/aes';
import { randomBytes } from '../../src/crypto/random';

describe('AES-256-GCM wallet encryption', () => {
  it('encrypts and decrypts a small payload', async () => {
    const plaintext = new TextEncoder().encode('hello, octra!');
    const pin = 'Pass1word!abc';
    const blob = await walletEncrypt(plaintext, pin, 1000);
    expect(blob.length).toBeGreaterThan(HEADER_LEN + 16);
    const decrypted = await walletDecrypt(blob, pin);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('preserves 1MB payload', async () => {
    const plaintext = randomBytes(1_000_000);
    const blob = await walletEncrypt(plaintext, 'Pass1word!abc', 1000);
    const decrypted = await walletDecrypt(blob, 'Pass1word!abc');
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('starts with OCT1 magic', async () => {
    const blob = await walletEncrypt(new Uint8Array([1, 2, 3]), 'Pass1word!', 1000);
    expect(Array.from(blob.subarray(0, 4))).toEqual(Array.from(WALLET_MAGIC));
  });

  it('writes version 1 at offset 4', async () => {
    const blob = await walletEncrypt(new Uint8Array([1]), 'Pass1word!', 1000);
    expect(blob[4]).toBe(1);
  });

  it('writes iteration count as big-endian uint32', async () => {
    const blob = await walletEncrypt(new Uint8Array([1]), 'Pass1word!', 12345);
    const dv = new DataView(blob.buffer, blob.byteOffset + 5, 4);
    expect(dv.getUint32(0, false)).toBe(12345);
  });

  it('throws on wrong PIN', async () => {
    const blob = await walletEncrypt(new TextEncoder().encode('secret'), 'Right1Pin!', 1000);
    await expect(walletDecrypt(blob, 'Wrong1Pin!')).rejects.toThrow('decryption failed');
  });

  it('throws on corrupted blob (bad magic)', async () => {
    const blob = await walletEncrypt(new Uint8Array([1]), 'Pass1word!', 1000);
    blob[0] = 0x00; // corrupt magic
    await expect(walletDecrypt(blob, 'Pass1word!')).rejects.toThrow('invalid magic');
  });

  it('throws on corrupted blob (bad version)', async () => {
    const blob = await walletEncrypt(new Uint8Array([1]), 'Pass1word!', 1000);
    blob[4] = 99; // unsupported version
    await expect(walletDecrypt(blob, 'Pass1word!')).rejects.toThrow('unsupported version');
  });

  it('throws on too-short blob', async () => {
    await expect(walletDecrypt(new Uint8Array(10), 'Pass1word!')).rejects.toThrow('blob too short');
  });

  it('uses different salt per encryption (random IV)', async () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const blob1 = await walletEncrypt(plaintext, 'Pass1word!', 1000);
    const blob2 = await walletEncrypt(plaintext, 'Pass1word!', 1000);
    // Salt is at offset 9..40
    const salt1 = blob1.subarray(9, 41);
    const salt2 = blob2.subarray(9, 41);
    expect(Array.from(salt1)).not.toEqual(Array.from(salt2));
  });
});

describe('deriveKeyFromPin', () => {
  it('returns a CryptoKey with AES-GCM algorithm', async () => {
    const salt = randomBytes(32);
    const key = await deriveKeyFromPin('Pass1word!', salt, 1000);
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.extractable).toBe(false);
    expect(key.usages).toContain('encrypt');
    expect(key.usages).toContain('decrypt');
  });

  it('produces different keys for different salts', async () => {
    const k1 = await deriveKeyFromPin('Pass1word!', randomBytes(32), 1000);
    const k2 = await deriveKeyFromPin('Pass1word!', randomBytes(32), 1000);
    expect(k1).not.toBe(k2); // different CryptoKey instances
  });
});

describe('aesGcmEncrypt / aesGcmDecrypt (raw key)', () => {
  it('round-trips small payload with AAD', async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const plaintext = new TextEncoder().encode('stealth amount');
    const aad = new TextEncoder().encode('additional data');
    const ct = await aesGcmEncrypt(plaintext, key, nonce, aad);
    const pt = await aesGcmDecrypt(ct, key, nonce, aad);
    expect(Array.from(pt)).toEqual(Array.from(plaintext));
  });

  it('round-trips without AAD', async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const plaintext = new Uint8Array(255);
    for (let i = 0; i < 255; i++) plaintext[i] = i;
    const ct = await aesGcmEncrypt(plaintext, key, nonce);
    const pt = await aesGcmDecrypt(ct, key, nonce);
    expect(Array.from(pt)).toEqual(Array.from(plaintext));
  });

  it('fails decryption with wrong key', async () => {
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const nonce = randomBytes(12);
    const ct = await aesGcmEncrypt(new Uint8Array([1, 2, 3]), key, nonce);
    await expect(aesGcmDecrypt(ct, wrongKey, nonce)).rejects.toThrow();
  });

  it('fails decryption with wrong AAD', async () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad1 = new TextEncoder().encode('aad1');
    const aad2 = new TextEncoder().encode('aad2');
    const ct = await aesGcmEncrypt(new Uint8Array([1, 2, 3]), key, nonce, aad1);
    await expect(aesGcmDecrypt(ct, key, nonce, aad2)).rejects.toThrow();
  });

  it('rejects non-32-byte keys', async () => {
    await expect(
      aesGcmEncrypt(new Uint8Array([1]), new Uint8Array(16), new Uint8Array(12)),
    ).rejects.toThrow('32 bytes');
  });

  it('rejects non-12-byte nonces', async () => {
    await expect(
      aesGcmEncrypt(new Uint8Array([1]), new Uint8Array(32), new Uint8Array(16)),
    ).rejects.toThrow('12 bytes');
  });
});
