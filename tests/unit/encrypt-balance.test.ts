import { describe, it, expect } from 'vitest';
import { signBalanceRequest, signRegisterRequest } from '../../src/tx/builder';
import { keypairFromSeed } from '../../src/crypto/ed25519';
import { base64Decode } from '../../src/crypto/base64';
import { randomBytes } from '../../src/crypto/random';

/**
 * The encrypt/decrypt flow itself requires the PVAC WASM module (FHE ciphertext
 * + bound zero-knowledge proofs), which is not loadable under jsdom. These tests
 * cover the request-signing helpers that gate the encrypted-balance RPC calls,
 * matching octra::sign_balance_request / sign_register_request.
 */
describe('encrypted balance request signing', () => {
  const seed = randomBytes(32);
  const kp = keypairFromSeed(seed);
  const addr = 'oct1111111111111111111111111111111111111111111';

  it('signs a balance request deterministically', () => {
    const a = signBalanceRequest(addr, kp.secretKey);
    const b = signBalanceRequest(addr, kp.secretKey);
    expect(a).toBe(b);
    expect(base64Decode(a).length).toBe(64);
  });

  it('produces a different signature for a different address', () => {
    const other = 'oct2222222222222222222222222222222222222222222';
    expect(signBalanceRequest(addr, kp.secretKey)).not.toBe(
      signBalanceRequest(other, kp.secretKey),
    );
  });

  it('signs a register request over the pubkey hash', () => {
    const pkBlob = randomBytes(128);
    const sig = signRegisterRequest(addr, pkBlob, kp.secretKey);
    expect(base64Decode(sig).length).toBe(64);
    // Different pubkey blob → different signature
    const sig2 = signRegisterRequest(addr, randomBytes(128), kp.secretKey);
    expect(sig).not.toBe(sig2);
  });
});
