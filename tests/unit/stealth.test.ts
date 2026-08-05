import { describe, it, expect } from 'vitest';
import {
  computeStealthTag,
  computeClaimSecret,
  computeClaimPub,
  deriveAmountKey,
  encryptStealthAmount,
  decryptStealthAmount,
  prepareStealthSend,
} from '../../src/stealth';
import { sha256 } from '../../src/crypto/sha256';
import { base64Decode, base64Encode } from '../../src/crypto/base64';
import { generateKeypair } from '../../src/crypto/ed25519';
import { ed25519PkToX25519, scalarMultBase } from '../../src/crypto/x25519';
import { hexEncode } from '../../src/crypto/hex';

describe('stealth transactions', () => {
  describe('computeStealthTag', () => {
    it('returns 32 bytes', () => {
      const shared = new Uint8Array(32).fill(0xab);
      const tag = computeStealthTag(shared);
      expect(tag.length).toBe(32);
    });

    it('is deterministic for the same shared secret', () => {
      const shared = new Uint8Array(32).fill(0xab);
      const t1 = computeStealthTag(shared);
      const t2 = computeStealthTag(shared);
      expect(t1).toEqual(t2);
    });

    it('produces different tags for different shared secrets', () => {
      const s1 = new Uint8Array(32).fill(0x01);
      const s2 = new Uint8Array(32).fill(0x02);
      expect(computeStealthTag(s1)).not.toEqual(computeStealthTag(s2));
    });

    it('equals sha256(shared || "octra-stealth-tag")', () => {
      const shared = new Uint8Array(32).fill(0xab);
      const tag = computeStealthTag(shared);
      const expected = sha256(
        new TextEncoder().encode(new TextDecoder().decode(shared) + 'octra-stealth-tag'),
      );
      // Note: TextDecoder may mangle binary data; verify the bytes manually
      const manualInput = new Uint8Array(shared.length + 'octra-stealth-tag'.length);
      manualInput.set(shared, 0);
      manualInput.set(new TextEncoder().encode('octra-stealth-tag'), shared.length);
      expect(tag).toEqual(sha256(manualInput));
      // Sanity: the expected calc above via TextDecoder may not match
      void expected;
    });
  });

  describe('computeClaimSecret', () => {
    it('returns 32 bytes', () => {
      const shared = new Uint8Array(32).fill(0xcd);
      const claim = computeClaimSecret(shared);
      expect(claim.length).toBe(32);
    });

    it('is deterministic', () => {
      const shared = new Uint8Array(32).fill(0xcd);
      expect(computeClaimSecret(shared)).toEqual(computeClaimSecret(shared));
    });

    it('produces different secrets for different shared secrets', () => {
      const s1 = new Uint8Array(32).fill(0x01);
      const s2 = new Uint8Array(32).fill(0x02);
      expect(computeClaimSecret(s1)).not.toEqual(computeClaimSecret(s2));
    });
  });

  describe('computeClaimPub', () => {
    it('returns 32 bytes', () => {
      const claim = new Uint8Array(32).fill(0xef);
      const pub = computeClaimPub(claim);
      expect(pub.length).toBe(32);
    });

    it('equals scalarMult_base(claim)', () => {
      const claim = new Uint8Array(32).fill(0xef);
      expect(computeClaimPub(claim)).toEqual(scalarMultBase(claim));
    });
  });

  describe('deriveAmountKey', () => {
    it('returns 32 bytes', () => {
      const shared = new Uint8Array(32).fill(0x12);
      expect(deriveAmountKey(shared).length).toBe(32);
    });

    it('is deterministic', () => {
      const shared = new Uint8Array(32).fill(0x12);
      expect(deriveAmountKey(shared)).toEqual(deriveAmountKey(shared));
    });
  });

  describe('encryptStealthAmount + decryptStealthAmount', () => {
    it('round-trips a small amount', async () => {
      const shared = new Uint8Array(32).fill(0x42);
      const amountRaw = '1500000';
      const { payload, blinding } = await encryptStealthAmount(shared, amountRaw);
      expect(payload.nonce).toBeTruthy();
      expect(payload.ciphertext).toBeTruthy();
      expect(payload.blinding).toBeTruthy();
      expect(blinding.length).toBe(32);

      const decrypted = await decryptStealthAmount(shared, payload);
      expect(decrypted.amountRaw).toBe(amountRaw);
      expect(Array.from(decrypted.blinding)).toEqual(Array.from(blinding));
    });

    it('round-trips a large amount', async () => {
      const shared = new Uint8Array(32).fill(0x99);
      const amountRaw = '1000000000000'; // 1 million OCT
      const { payload } = await encryptStealthAmount(shared, amountRaw);
      const decrypted = await decryptStealthAmount(shared, payload);
      expect(decrypted.amountRaw).toBe(amountRaw);
    });

    it('fails decryption with the wrong shared secret', async () => {
      const shared1 = new Uint8Array(32).fill(0x42);
      const shared2 = new Uint8Array(32).fill(0x99);
      const { payload } = await encryptStealthAmount(shared1, '1000');
      await expect(decryptStealthAmount(shared2, payload)).rejects.toThrow();
    });

    it('produces different ciphertexts for the same input (random nonce)', async () => {
      const shared = new Uint8Array(32).fill(0x42);
      const { payload: p1 } = await encryptStealthAmount(shared, '1000');
      const { payload: p2 } = await encryptStealthAmount(shared, '1000');
      expect(p1.nonce).not.toBe(p2.nonce);
      expect(p1.ciphertext).not.toBe(p2.ciphertext);
    });

    it('blinding in payload matches the returned blinding', async () => {
      const shared = new Uint8Array(32).fill(0x42);
      const { payload, blinding } = await encryptStealthAmount(shared, '1000');
      expect(payload.blinding).toBe(base64Encode(blinding));
    });
  });

  describe('prepareStealthSend', () => {
    it('derives ephemeral keypair, shared secret, and stealth/claim keys', async () => {
      // Generate recipient Ed25519 keypair
      const recipient = generateKeypair();

      const prepared = await prepareStealthSend({
        recipientEd25519Pubkey: recipient.publicKey,
        amountRaw: '1000000',
      });

      // All fields should be populated
      expect(prepared.ephemeralPubkey.length).toBe(32);
      expect(prepared.ephemeralPubkeyB64).toBe(base64Encode(prepared.ephemeralPubkey));
      expect(prepared.sharedSecret.length).toBe(32);
      expect(prepared.stealthTag.length).toBe(32);
      expect(prepared.stealthTagHex).toBe(hexEncode(prepared.stealthTag));
      expect(prepared.claimSecret.length).toBe(32);
      expect(prepared.claimPub.length).toBe(32);
      expect(prepared.claimPubB64).toBe(base64Encode(prepared.claimPub));
      expect(prepared.amountPayload).toBeTruthy();
      expect(prepared.blinding.length).toBe(32);

      // Verify claim_pub = scalarMult_base(claim_secret)
      expect(prepared.claimPub).toEqual(scalarMultBase(prepared.claimSecret));
    });

    it('produces a shared secret that the recipient can recompute', async () => {
      // Generate recipient Ed25519 keypair
      const recipient = generateKeypair();

      const prepared = await prepareStealthSend({
        recipientEd25519Pubkey: recipient.publicKey,
        amountRaw: '500',
      });

      // Recipient computes the same shared secret using:
      //   their X25519 secret key + the ephemeral X25519 public key
      const recipientX25519Sk = await (async () => {
        // Convert Ed25519 secret key (seed||pub, 64 bytes) → X25519 secret (32 bytes)
        // Use the seed for conversion
        const { ed25519SkToX25519 } = await import('../../src/crypto/x25519');
        return ed25519SkToX25519(recipient.secretKey);
      })();
      const ephPub = prepared.ephemeralPubkey;

      // ECDH: shared = sha256(scalarmult(recipientX25519Sk, ephPub))
      const { scalarMult, ecdhSharedSecret } = await import('../../src/crypto/x25519');
      const rawShared = scalarMult(recipientX25519Sk, ephPub);
      const recomputedShared = sha256(rawShared);
      void ecdhSharedSecret;

      expect(recomputedShared).toEqual(prepared.sharedSecret);

      // Recipient can decrypt the amount using the shared secret
      const decrypted = await decryptStealthAmount(prepared.sharedSecret, prepared.amountPayload);
      expect(decrypted.amountRaw).toBe('500');
    });

    it('rejects a non-32-byte recipient public key', async () => {
      await expect(
        prepareStealthSend({
          recipientEd25519Pubkey: new Uint8Array(16),
          amountRaw: '1000',
        }),
      ).rejects.toThrow('32 bytes');
    });

    it('produces different ephemeral keys per call (random)', async () => {
      const recipient = generateKeypair();
      const p1 = await prepareStealthSend({
        recipientEd25519Pubkey: recipient.publicKey,
        amountRaw: '1000',
      });
      const p2 = await prepareStealthSend({
        recipientEd25519Pubkey: recipient.publicKey,
        amountRaw: '1000',
      });
      expect(p1.ephemeralPubkey).not.toEqual(p2.ephemeralPubkey);
      expect(p1.sharedSecret).not.toEqual(p2.sharedSecret);
    });
  });

  describe('Ed25519 → X25519 conversion (used by stealth)', () => {
    it('converts a stable Ed25519 public key to X25519', async () => {
      const kp = generateKeypair();
      const x25519Pub = await ed25519PkToX25519(kp.publicKey);
      expect(x25519Pub.length).toBe(32);
    });

    it('is deterministic', async () => {
      const kp = generateKeypair();
      const a = await ed25519PkToX25519(kp.publicKey);
      const b = await ed25519PkToX25519(kp.publicKey);
      expect(a).toEqual(b);
    });

    it('produces different X25519 keys for different Ed25519 keys', async () => {
      const kp1 = generateKeypair();
      const kp2 = generateKeypair();
      const a = await ed25519PkToX25519(kp1.publicKey);
      const b = await ed25519PkToX25519(kp2.publicKey);
      expect(a).not.toEqual(b);
    });
  });
});

// Helper import for the inline test
void base64Decode;
