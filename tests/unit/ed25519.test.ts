import { describe, it, expect } from 'vitest';
import {
  keypairFromSeed,
  sign,
  verify,
  generateKeypair,
  signNoble,
  verifyNoble,
  verifyBoth,
} from '../../src/crypto/ed25519';
import { hexDecode, hexEncode } from '../../src/crypto/hex';

describe('ed25519', () => {
  // Stable self-generated test vector (seed = 1..32)
  // Verified to match across tweetnacl AND @noble/curves backends.
  const STABLE = {
    SEED: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    PUB: '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664',
    SK: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664',
    MESSAGE: 'hello',
    SIG: '6970dad564d940df9017a22431bc2d52fae0b56ce07b860fbe3819fe7128653ccb4ce6c05aef0141e84b1428cc6289fd6e1d5a0941e2005f4dfe534cdbb1990e',
  };

  it('derives the stable public key from seed', () => {
    const seed = hexDecode(STABLE.SEED);
    const kp = keypairFromSeed(seed);
    expect(hexEncode(kp.publicKey)).toBe(STABLE.PUB);
    expect(hexEncode(kp.secretKey)).toBe(STABLE.SK);
    expect(hexEncode(kp.seed)).toBe(STABLE.SEED);
  });

  it('signs "hello" producing the stable signature', () => {
    const seed = hexDecode(STABLE.SEED);
    const kp = keypairFromSeed(seed);
    const msg = new TextEncoder().encode(STABLE.MESSAGE);
    const sig = sign(msg, kp.secretKey);
    expect(hexEncode(sig)).toBe(STABLE.SIG);
  });

  it('verifies the stable signature', () => {
    const pub = hexDecode(STABLE.PUB);
    const sig = hexDecode(STABLE.SIG);
    const msg = new TextEncoder().encode(STABLE.MESSAGE);
    expect(verify(msg, sig, pub)).toBe(true);
  });

  it('rejects wrong-message signature', () => {
    const pub = hexDecode(STABLE.PUB);
    const sig = hexDecode(STABLE.SIG);
    expect(verify(new TextEncoder().encode('different'), sig, pub)).toBe(false);
  });

  it('rejects wrong public key', () => {
    const sig = hexDecode(STABLE.SIG);
    const msg = new TextEncoder().encode(STABLE.MESSAGE);
    // Generate a different keypair
    const other = generateKeypair();
    expect(verify(msg, sig, other.publicKey)).toBe(false);
  });

  it('rejects tampered signature', () => {
    const pub = hexDecode(STABLE.PUB);
    const sig = hexDecode(STABLE.SIG);
    const msg = new TextEncoder().encode(STABLE.MESSAGE);
    const tampered = new Uint8Array(sig);
    tampered[0]! ^= 0x01;
    expect(verify(msg, tampered, pub)).toBe(false);
  });

  it('generates a fresh keypair from random seed', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.publicKey.length).toBe(32);
    expect(kp1.secretKey.length).toBe(64);
    expect(kp1.seed.length).toBe(32);
  });

  it('cross-checks tweetnacl and noble backends (verify)', () => {
    const kp = generateKeypair();
    const msg = new TextEncoder().encode('cross-check');
    const sig = sign(msg, kp.secretKey);
    expect(verify(msg, sig, kp.publicKey)).toBe(true);
    expect(verifyNoble(msg, sig, kp.publicKey)).toBe(true);
    expect(verifyBoth(msg, sig, kp.publicKey)).toBe(true);
  });

  it('noble sign produces same signature as tweetnacl', () => {
    const kp = generateKeypair();
    const msg = new TextEncoder().encode('test message');
    const sigNacl = sign(msg, kp.secretKey);
    const sigNoble = signNoble(msg, kp.seed);
    expect(hexEncode(sigNacl)).toBe(hexEncode(sigNoble));
  });

  it('signs an empty message', () => {
    const kp = generateKeypair();
    const sig = sign(new Uint8Array(0), kp.secretKey);
    expect(sig.length).toBe(64);
    expect(verify(new Uint8Array(0), sig, kp.publicKey)).toBe(true);
  });

  it('signs a 1000-byte message', () => {
    const kp = generateKeypair();
    const msg = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) msg[i] = i & 0xff;
    const sig = sign(msg, kp.secretKey);
    expect(verify(msg, sig, kp.publicKey)).toBe(true);
  });

  it('rejects secret key of wrong length', () => {
    expect(() => sign(new Uint8Array(0), new Uint8Array(32))).toThrow('64 bytes');
  });
});
