import { describe, it, expect } from 'vitest';
import {
  sha256,
  sha512,
  sha256Str,
  doubleSha256,
  hmacSha256,
  sha256Async,
} from '../../src/crypto/sha256';

describe('sha256', () => {
  // Test vectors from NIST FIPS 180-4
  it('hashes empty string', () => {
    expect(sha256Str('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256Str('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes "Hello, World!"', () => {
    expect(sha256Str('Hello, World!')).toBe(
      'dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f',
    );
  });

  it('hashes long string (> 64 bytes)', () => {
    const s = 'a'.repeat(1_000_000);
    const h = sha256Str(s);
    expect(h).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('returns 32-byte digest', () => {
    const h = sha256(new TextEncoder().encode('test'));
    expect(h.length).toBe(32);
  });

  it('async variant matches sync', async () => {
    const bytes = new TextEncoder().encode('test');
    const sync = sha256(bytes);
    const async_ = await sha256Async(bytes);
    expect(async_).toEqual(sync);
  });
});

describe('sha512', () => {
  it('hashes empty string', () => {
    const h = sha512(new TextEncoder().encode(''));
    expect(h.length).toBe(64);
    // NIST vector: cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e
    expect(
      Array.from(h.subarray(0, 16))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    ).toBe('cf83e1357eefb8bdf1542850d66d8007');
  });

  it('hashes "abc"', () => {
    const h = sha512(new TextEncoder().encode('abc'));
    // First 16 bytes of ddaf35a193617aba...
    expect(
      Array.from(h.subarray(0, 16))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    ).toBe('ddaf35a193617abacc417349ae204131');
  });
});

describe('doubleSha256', () => {
  it('equals sha256(sha256(x))', () => {
    const bytes = new TextEncoder().encode('test');
    expect(doubleSha256(bytes)).toEqual(sha256(sha256(bytes)));
  });
});

describe('hmacSha256', () => {
  // RFC 4231 Test Case 1 (SHA-256 variant)
  it('matches RFC 4231 test case 1', () => {
    const key = new Uint8Array(20).fill(0x0b);
    const data = new TextEncoder().encode('Hi There');
    const mac = hmacSha256(key, data);
    const expected = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
    expect(
      Array.from(mac)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    ).toBe(expected);
  });
});
