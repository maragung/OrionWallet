import { describe, it, expect } from 'vitest';
import { base64Encode, base64Decode } from '../../src/crypto/base64';
import { base58Encode, base58Decode, isValidBase58 } from '../../src/crypto/base58';

describe('base64', () => {
  it('encodes empty array', () => {
    expect(base64Encode(new Uint8Array(0))).toBe('');
  });

  it('encodes "Hello, World!"', () => {
    const bytes = new TextEncoder().encode('Hello, World!');
    expect(base64Encode(bytes)).toBe(btoa('Hello, World!'));
  });

  it('round-trips random bytes', () => {
    const bytes = new Uint8Array(255);
    for (let i = 0; i < 255; i++) bytes[i] = i;
    const encoded = base64Encode(bytes);
    const decoded = base64Decode(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('decodes with whitespace', () => {
    const bytes = new TextEncoder().encode('test data 123');
    const encoded = base64Encode(bytes);
    const decoded = base64Decode(encoded.replace(/(.{4})/g, '$1 '));
    // Compare via Array.from to avoid cross-realm Uint8Array identity issues
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('rejects invalid length', () => {
    expect(() => base64Decode('abc')).toThrow('invalid length');
  });
});

describe('base58', () => {
  it('encodes empty array', () => {
    expect(base58Encode(new Uint8Array(0))).toBe('');
  });

  it('encodes leading zero bytes as "1" prefix', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('11')).toBe(true);
  });

  it('round-trips random 32-byte hash', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 13 + 7) & 0xff;
    const encoded = base58Encode(bytes);
    // base58 of 32 bytes is typically 43-44 chars
    expect([43, 44]).toContain(encoded.length);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it('rejects invalid characters', () => {
    expect(() => base58Decode('0OIl')).toThrow('invalid character');
  });

  it('isValidBase58 accepts valid string', () => {
    expect(isValidBase58('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')).toBe(true);
  });

  it('isValidBase58 rejects 0, O, I, l', () => {
    expect(isValidBase58('0')).toBe(false);
    expect(isValidBase58('O')).toBe(false);
    expect(isValidBase58('I')).toBe(false);
    expect(isValidBase58('l')).toBe(false);
  });
});
