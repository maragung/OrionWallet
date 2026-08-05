import { describe, it, expect, vi, afterEach } from 'vitest';
import { gcm } from '@noble/ciphers/aes';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

/** Copy a Uint8Array into a fresh ArrayBuffer to satisfy WebCrypto BufferSource typing. */
function buf(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

/**
 * Cross-compatibility: the non-secure-context (pure-JS noble) fallback in
 * aes.ts must produce byte-identical output to WebCrypto, so a wallet
 * encrypted in one context decrypts in the other.
 */
describe('AES fallback (non-secure context) cross-compat', () => {
  afterEach(() => vi.restoreAllMocks());

  it('noble gcm decrypts what WebCrypto AES-GCM encrypted (same key+nonce)', async () => {
    const keyBytes = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
    const nonce = new Uint8Array(12).map((_, i) => (i * 11 + 1) & 0xff);
    const plaintext = new TextEncoder().encode('octra secret payload — αβγ 12345');

    // Encrypt with native WebCrypto
    const key = await crypto.subtle.importKey('raw', buf(keyBytes), { name: 'AES-GCM' }, false, [
      'encrypt',
    ]);
    const ctBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buf(nonce) },
      key,
      buf(plaintext),
    );
    const ct = new Uint8Array(ctBuf);

    // Decrypt with noble
    const dec = gcm(keyBytes, nonce).decrypt(ct);
    expect(Array.from(dec)).toEqual(Array.from(plaintext));
  });

  it('WebCrypto decrypts what noble gcm encrypted (same key+nonce)', async () => {
    const keyBytes = new Uint8Array(32).map((_, i) => (i * 5 + 9) & 0xff);
    const nonce = new Uint8Array(12).map((_, i) => (i * 3 + 2) & 0xff);
    const plaintext = new TextEncoder().encode('round-trip-check');

    const ct = gcm(keyBytes, nonce).encrypt(plaintext);

    const key = await crypto.subtle.importKey('raw', buf(keyBytes), { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);
    const decBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(ct));
    expect(Array.from(new Uint8Array(decBuf))).toEqual(Array.from(plaintext));
  });

  it('PBKDF2-SHA-256 noble matches WebCrypto deriveBits', async () => {
    const pin = 'Pass1word!abc';
    const salt = new Uint8Array(32).map((_, i) => (i * 13 + 4) & 0xff);
    const iterations = 10_000;

    const km = await crypto.subtle.importKey(
      'raw',
      buf(new TextEncoder().encode(pin)),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: buf(salt), iterations, hash: 'SHA-256' },
      km,
      256,
    );
    const webKey = new Uint8Array(bits);
    const nobleKey = noblePbkdf2(nobleSha256, new TextEncoder().encode(pin), salt, {
      c: iterations,
      dkLen: 32,
    });
    expect(Array.from(nobleKey)).toEqual(Array.from(webKey));
  });

  it('walletEncrypt/walletDecrypt still round-trips when crypto.subtle is forced undefined', async () => {
    // Force the non-secure-context path by hiding subtle.
    const realSubtle = globalThis.crypto.subtle;
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      get: () => undefined,
    });
    try {
      // Import fresh so hasSubtle() re-evaluates at call time (it does, per-call).
      const { walletEncrypt, walletDecrypt } = await import('../../src/crypto/aes');
      const pt = new TextEncoder().encode('fallback wallet blob');
      const blob = await walletEncrypt(pt, 'Pass1word!abc', 10_000);
      const back = await walletDecrypt(blob, 'Pass1word!abc');
      expect(Array.from(back)).toEqual(Array.from(pt));

      // wrong PIN must fail
      await expect(walletDecrypt(blob, 'wrongpin')).rejects.toThrow(/decryption failed/);
    } finally {
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        get: () => realSubtle,
      });
    }
  });

  it('cross-context: encrypt with WebCrypto path, decrypt with fallback path', async () => {
    const { walletEncrypt, walletDecrypt } = await import('../../src/crypto/aes');
    const pt = new TextEncoder().encode('secure->insecure wallet');

    // Encrypt in secure context (subtle available)
    const blob = await walletEncrypt(pt, 'Pass1word!abc', 10_000);

    // Now hide subtle and decrypt via fallback
    const realSubtle = globalThis.crypto.subtle;
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      get: () => undefined,
    });
    try {
      const back = await walletDecrypt(blob, 'Pass1word!abc');
      expect(Array.from(back)).toEqual(Array.from(pt));
    } finally {
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        get: () => realSubtle,
      });
    }
  });
});
