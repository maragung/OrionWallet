import { describe, it, expect } from 'vitest';
import {
  generateMnemonic12,
  generateMnemonic,
  validateMnemonic,
  entropyToMnemonic,
} from '../../src/crypto/bip39';
import { randomBytes } from '../../src/crypto/random';
import { hexEncode } from '../../src/crypto/hex';

describe('bip39', () => {
  // BIP39 test vectors from https://github.com/trezor/python-mnemonic/blob/master/vectors.json
  const TREZOR_VECTOR_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('derives mnemonic from entropy per Trezor vector', () => {
    const entropy = new Uint8Array(16);
    // All-zero entropy → "abandon abandon ... about"
    const mnemonic = entropyToMnemonic(entropy, 128);
    expect(mnemonic).toBe(TREZOR_VECTOR_MNEMONIC);
  });

  it('validates the Trezor vector mnemonic', () => {
    expect(validateMnemonic(TREZOR_VECTOR_MNEMONIC)).toBe(true);
  });

  it('generates a 12-word mnemonic', () => {
    const m = generateMnemonic12();
    const words = m.split(' ');
    expect(words.length).toBe(12);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('generates a 24-word mnemonic', () => {
    const m = generateMnemonic(256);
    const words = m.split(' ');
    expect(words.length).toBe(24);
    expect(validateMnemonic(m)).toBe(true);
  });

  it('rejects mnemonics with wrong word count', () => {
    expect(validateMnemonic('abandon abandon abandon')).toBe(false);
    expect(
      validateMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
      ),
    ).toBe(false);
  });

  it('rejects mnemonics with invalid words', () => {
    expect(
      validateMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon notaword',
      ),
    ).toBe(false);
  });

  it('rejects mnemonics with bad checksum', () => {
    // Replace last word with a different valid word to break checksum
    const bad = TREZOR_VECTOR_MNEMONIC.replace('about', 'abandon');
    expect(validateMnemonic(bad)).toBe(false);
  });

  it('handles all-1s entropy vector', () => {
    const entropy = new Uint8Array(16).fill(0xff);
    const mnemonic = entropyToMnemonic(entropy, 128);
    // All-1s entropy → "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"
    expect(mnemonic).toBe('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  it('round-trips random entropy', () => {
    for (let i = 0; i < 10; i++) {
      const entropy = randomBytes(16);
      const mnemonic = entropyToMnemonic(entropy, 128);
      expect(validateMnemonic(mnemonic)).toBe(true);
    }
  });

  it('hex entropy round-trips', () => {
    const entropy = new Uint8Array([
      0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f,
      0x7f,
    ]);
    const mnemonic = entropyToMnemonic(entropy, 128);
    expect(validateMnemonic(mnemonic)).toBe(true);
    // Sanity: hex output of entropy
    expect(hexEncode(entropy)).toBe('7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f');
  });
});
