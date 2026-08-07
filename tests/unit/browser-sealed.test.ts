import { describe, it, expect } from 'vitest';
import { resourceKeyOfPath, deriveReadKeyBytes, decryptSealedBytes } from '../../src/browser/sealed';
import { aesGcmEncrypt } from '../../src/crypto/aes';
import { sha256 } from '../../src/crypto/sha256';
import { hexEncode } from '../../src/crypto/hex';
import { base64Encode } from '../../src/crypto/base64';

const enc = new TextEncoder();

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

/**
 * Build an OCRS1 envelope the same way the network would, so we can verify our
 * decrypter round-trips: magic || nonce[12] || AES-GCM( u32be(len) || plaintext ).
 */
async function makeEnvelope(
  circleId: string,
  keyId: string,
  passphrase: string,
  plaintext: Uint8Array,
): Promise<string> {
  const key = await deriveReadKeyBytes(circleId, keyId, passphrase);
  const nonce = new Uint8Array(12); // deterministic for the test
  const frame = new Uint8Array(4 + plaintext.length);
  frame.set(u32be(plaintext.length), 0);
  frame.set(plaintext, 4);
  const cipher = await aesGcmEncrypt(frame, key, nonce);
  const magic = enc.encode('OCRS1');
  const env = new Uint8Array(magic.length + nonce.length + cipher.length);
  env.set(magic, 0);
  env.set(nonce, magic.length);
  env.set(cipher, magic.length + nonce.length);
  return base64Encode(env);
}

describe('sealed circle crypto', () => {
  it('resourceKeyOfPath is deterministic and path-sensitive', () => {
    const a = resourceKeyOfPath('octABC', '/index.html');
    const b = resourceKeyOfPath('octABC', '/index.html');
    const c = resourceKeyOfPath('octABC', '/other.html');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives a 32-byte read key', async () => {
    const k = await deriveReadKeyBytes('octABC', 'key1', 'hunter2');
    expect(k.length).toBe(32);
  });

  it('decrypts a well-formed OCRS1 envelope and verifies the hash', async () => {
    const plaintext = enc.encode('<h1>hello circle</h1>');
    const ciphertext_b64 = await makeEnvelope('octABC', 'key1', 'pw', plaintext);
    const out = await decryptSealedBytes(
      'octABC',
      {
        ciphertext_b64,
        key_id: 'key1',
        plaintext_hash: hexEncode(sha256(plaintext)),
        content_type: 'text/html',
      },
      'pw',
    );
    expect(new TextDecoder().decode(out)).toBe('<h1>hello circle</h1>');
  });

  it('rejects a wrong passphrase', async () => {
    const plaintext = enc.encode('secret');
    const ciphertext_b64 = await makeEnvelope('octABC', 'key1', 'right', plaintext);
    await expect(
      decryptSealedBytes(
        'octABC',
        { ciphertext_b64, key_id: 'key1', plaintext_hash: hexEncode(sha256(plaintext)) },
        'wrong',
      ),
    ).rejects.toThrow();
  });

  it('rejects a tampered plaintext hash', async () => {
    const plaintext = enc.encode('data');
    const ciphertext_b64 = await makeEnvelope('octABC', 'key1', 'pw', plaintext);
    await expect(
      decryptSealedBytes(
        'octABC',
        { ciphertext_b64, key_id: 'key1', plaintext_hash: 'deadbeef' },
        'pw',
      ),
    ).rejects.toThrow(/hash mismatch/);
  });

  it('rejects a bad magic', async () => {
    await expect(
      decryptSealedBytes(
        'octABC',
        { ciphertext_b64: base64Encode(enc.encode('XXXXX........')), key_id: 'k', plaintext_hash: 'x' },
        'pw',
      ),
    ).rejects.toThrow(/invalid sealed envelope/);
  });

  it('rejects incomplete metadata', async () => {
    await expect(
      decryptSealedBytes('octABC', { ciphertext_b64: 'AAAA' }, 'pw'),
    ).rejects.toThrow(/incomplete/);
  });
});
