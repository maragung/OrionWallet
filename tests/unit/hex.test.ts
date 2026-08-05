import { describe, it, expect } from 'vitest';
import { hexEncode, hexDecode } from '../../src/crypto/hex';

describe('hex', () => {
  it('encodes an empty array', () => {
    expect(hexEncode(new Uint8Array(0))).toBe('');
  });

  it('encodes bytes correctly', () => {
    expect(hexEncode(new Uint8Array([0, 1, 2, 255]))).toBe('000102ff');
  });

  it('decodes hex correctly (lowercase)', () => {
    expect(hexDecode('000102ff')).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  it('decodes hex correctly (uppercase)', () => {
    expect(hexDecode('000102FF')).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  it('round-trips random bytes', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 7) & 0xff;
    expect(hexDecode(hexEncode(bytes))).toEqual(bytes);
  });

  it('rejects odd-length input', () => {
    expect(() => hexDecode('abc')).toThrow('odd-length');
  });

  it('rejects invalid chars', () => {
    expect(() => hexDecode('xy')).toThrow('invalid hex');
  });
});
