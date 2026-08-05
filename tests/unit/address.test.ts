import { describe, it, expect } from 'vitest';
import {
  deriveAddressFromPubkey,
  isValidAddress,
  addressToPayload,
} from '../../src/crypto/address';
import { generateKeypair } from '../../src/crypto/ed25519';
import { base58Decode } from '../../src/crypto/base58';
import { sha256 } from '../../src/crypto/sha256';

describe('address', () => {
  it('derives a 47-char address from a 32-byte pubkey', () => {
    const kp = generateKeypair();
    const addr = deriveAddressFromPubkey(kp.publicKey);
    expect(addr).toMatch(/^oct[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(addr.length).toBe(47);
  });

  it('derivation is deterministic', () => {
    const kp = generateKeypair();
    const addr1 = deriveAddressFromPubkey(kp.publicKey);
    const addr2 = deriveAddressFromPubkey(kp.publicKey);
    expect(addr1).toBe(addr2);
  });

  it('validates a correct address', () => {
    const kp = generateKeypair();
    const addr = deriveAddressFromPubkey(kp.publicKey);
    expect(isValidAddress(addr)).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidAddress('oct' + 'a'.repeat(43))).toBe(false);
    expect(isValidAddress('oct' + 'a'.repeat(45))).toBe(false);
  });

  it('rejects wrong prefix', () => {
    expect(isValidAddress('oCT' + 'a'.repeat(44))).toBe(false);
    expect(isValidAddress('oxt' + 'a'.repeat(44))).toBe(false);
  });

  it('rejects invalid base58 chars', () => {
    // 0, O, I, l are invalid in base58
    expect(isValidAddress('oct' + '0'.repeat(44))).toBe(false);
    expect(isValidAddress('oct' + 'O'.repeat(44))).toBe(false);
    expect(isValidAddress('oct' + 'I'.repeat(44))).toBe(false);
    expect(isValidAddress('oct' + 'l'.repeat(44))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidAddress(123 as unknown as string)).toBe(false);
    expect(isValidAddress(null as unknown as string)).toBe(false);
    expect(isValidAddress(undefined as unknown as string)).toBe(false);
  });

  it('address payload equals sha256(pubkey)', () => {
    const kp = generateKeypair();
    const addr = deriveAddressFromPubkey(kp.publicKey);
    const payload = addressToPayload(addr);
    const expected = sha256(kp.publicKey);
    expect(payload).toEqual(expected);
  });

  it('address payload from base58 decode is 32-33 bytes (padding adds at most 1 byte)', () => {
    const kp = generateKeypair();
    const addr = deriveAddressFromPubkey(kp.publicKey);
    const payload = base58Decode(addr.slice(3));
    // base58 decoding includes any leading-zero padding we added as '1' chars.
    // The decoded length is 32 bytes (no padding) or 33 bytes (1-byte padding).
    expect(payload.length).toBeGreaterThanOrEqual(32);
    expect(payload.length).toBeLessThanOrEqual(33);
  });
});
