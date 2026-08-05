/**
 * Stealth transaction primitives.
 * Ported from lib/stealth.hpp (ecdh_shared_secret, compute_stealth_tag,
 * compute_claim_secret, compute_claim_pub, encrypt_stealth_amount).
 *
 * Flow (mirrors C++ /api/stealth/send):
 *   1. Convert recipient's Ed25519 signing pubkey → X25519 (libsodium)
 *   2. Generate ephemeral X25519 keypair
 *   3. ECDH: shared = SHA-256(scalarmult(eph_sk, their_vpub))
 *   4. Derive stealth_tag = SHA-256(shared || "octra-stealth-tag")
 *   5. Derive claim_secret = SHA-512(shared || "octra-claim-secret")[0:32]
 *   6. Derive claim_pub = scalarmult_base(claim_secret)
 *   7. Encrypt amount: AES-256-GCM(key=SHA-256(shared||"amt"), nonce=random[12], plaintext=amount+blinding)
 */
import { sha256, sha512 } from '../crypto/sha256';
import { randomBytes } from '../crypto/random';
import {
  ed25519PkToX25519,
  scalarMult,
  scalarMultBase,
  generateX25519Keypair,
} from '../crypto/x25519';
import { aesGcmEncrypt, aesGcmDecrypt } from '../crypto/aes';
import { base64Encode, base64Decode } from '../crypto/base64';
import {
  noopProgress,
  shorten,
  b64Size,
  type ProgressReporter,
  type StepDescriptor,
} from '../utils/progress';

/** Compute the stealth tag (32 bytes) from a shared secret. */
export function computeStealthTag(sharedSecret: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('octra-stealth-tag');
  const combined = new Uint8Array(sharedSecret.length + tag.length);
  combined.set(sharedSecret, 0);
  combined.set(tag, sharedSecret.length);
  return sha256(combined);
}

/** Compute the claim secret (32 bytes) from a shared secret. */
export function computeClaimSecret(sharedSecret: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('octra-claim-secret');
  const combined = new Uint8Array(sharedSecret.length + tag.length);
  combined.set(sharedSecret, 0);
  combined.set(tag, sharedSecret.length);
  // Use first 32 bytes of SHA-512
  return sha512(combined).subarray(0, 32);
}

/** Compute the claim public key (X25519 public) from a claim secret. */
export function computeClaimPub(claimSecret: Uint8Array): Uint8Array {
  return scalarMultBase(claimSecret);
}

/** Derive the AES-256 key used for stealth amount encryption. */
export function deriveAmountKey(sharedSecret: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode('octra-stealth-amt');
  const combined = new Uint8Array(sharedSecret.length + tag.length);
  combined.set(sharedSecret, 0);
  combined.set(tag, sharedSecret.length);
  return sha256(combined);
}

export interface StealthAmountPayload {
  /** 12-byte nonce, base64-encoded. */
  nonce: string;
  /** Ciphertext+tag (WebCrypto AES-GCM appends tag at end), base64-encoded. */
  ciphertext: string;
  /** 32-byte blinding factor, base64-encoded. */
  blinding: string;
}

/**
 * Encrypt a stealth amount for a recipient given the shared secret.
 * @param sharedSecret 32-byte ECDH shared secret
 * @param amountRaw raw integer amount (string)
 * @returns { payload, blinding } — payload goes into encrypted_data, blinding is kept locally
 */
export async function encryptStealthAmount(
  sharedSecret: Uint8Array,
  amountRaw: string,
): Promise<{ payload: StealthAmountPayload; blinding: Uint8Array }> {
  const key = deriveAmountKey(sharedSecret);
  const nonce = randomBytes(12);
  const blinding = randomBytes(32);
  // Plaintext = ASCII amountRaw || blinding (32 bytes)
  const amtBytes = new TextEncoder().encode(amountRaw);
  const plaintext = new Uint8Array(amtBytes.length + 32);
  plaintext.set(amtBytes, 0);
  plaintext.set(blinding, amtBytes.length);
  const ct = await aesGcmEncrypt(plaintext, key, nonce);
  return {
    payload: {
      nonce: base64Encode(nonce),
      ciphertext: base64Encode(ct),
      blinding: base64Encode(blinding),
    },
    blinding,
  };
}

/** Decrypt a stealth amount payload using the shared secret. */
export async function decryptStealthAmount(
  sharedSecret: Uint8Array,
  payload: StealthAmountPayload,
): Promise<{ amountRaw: string; blinding: Uint8Array }> {
  const key = deriveAmountKey(sharedSecret);
  const nonce = base64Decode(payload.nonce);
  const ct = base64Decode(payload.ciphertext);
  const plaintext = await aesGcmDecrypt(ct, key, nonce);
  const amtEnd = plaintext.length - 32;
  if (amtEnd < 0) throw new Error('decryptStealthAmount: plaintext too short');
  const amountRaw = new TextDecoder().decode(plaintext.subarray(0, amtEnd));
  const blinding = plaintext.subarray(amtEnd);
  return { amountRaw, blinding };
}

export interface StealthSendInputs {
  recipientEd25519Pubkey: Uint8Array; // 32 bytes — fetched via RPC getPublicKey
  amountRaw: string;
}

/**
 * Steps performed inside `prepareStealthSend`, in execution order. Exported so
 * the UI can seed its step list; the ids match the `progress` calls below.
 */
export const STEALTH_PREPARE_STEPS: StepDescriptor[] = [
  {
    id: 'convert-key',
    label: 'Converting recipient key to X25519',
    description: 'Mapping the Ed25519 signing key onto the Montgomery curve',
  },
  {
    id: 'ephemeral',
    label: 'Generating ephemeral keypair',
    description: 'One-time X25519 key, discarded after this transaction',
  },
  {
    id: 'ecdh',
    label: 'Deriving ECDH shared secret',
    description: 'scalarmult(ephemeral_sk, recipient_vpub) hashed with SHA-256',
  },
  {
    id: 'stealth-tag',
    label: 'Computing stealth tag',
    description: 'SHA-256(shared ‖ "octra-stealth-tag") — the recipient scans for this',
  },
  {
    id: 'claim-key',
    label: 'Deriving one-time claim key',
    description: 'SHA-512(shared ‖ "octra-claim-secret") → X25519 public key',
  },
  {
    id: 'encrypt-amount',
    label: 'Encrypting the amount',
    description: 'AES-256-GCM over amount ‖ blinding factor',
  },
];

export interface StealthSendPrepared {
  ephemeralPubkey: Uint8Array; // 32-byte X25519 public
  ephemeralPubkeyB64: string;
  sharedSecret: Uint8Array;
  stealthTag: Uint8Array;
  stealthTagHex: string;
  claimSecret: Uint8Array;
  claimPub: Uint8Array;
  claimPubB64: string;
  amountPayload: StealthAmountPayload;
  blinding: Uint8Array;
}

/**
 * Prepare a stealth send: derive ephemeral key, ECDH, compute stealth/claim keys,
 * encrypt amount. Returns everything needed to build the stealth transaction.
 *
 * The caller is responsible for fetching the recipient's Ed25519 pubkey
 * via `rpc.getPublicKey(to)` and for converting it to bytes.
 */
export async function prepareStealthSend(
  inputs: StealthSendInputs,
  progress: ProgressReporter = noopProgress,
): Promise<StealthSendPrepared> {
  if (inputs.recipientEd25519Pubkey.length !== 32) {
    throw new Error(
      `prepareStealthSend: recipient pubkey must be 32 bytes, got ${inputs.recipientEd25519Pubkey.length}`,
    );
  }
  // Step 1: Ed25519 → X25519 (recipient)
  await progress.begin('convert-key');
  const theirVpub = await ed25519PkToX25519(inputs.recipientEd25519Pubkey);
  await progress.done('convert-key', `View key ${shorten(base64Encode(theirVpub))}`);

  // Step 2: ephemeral X25519 keypair
  await progress.begin('ephemeral');
  const eph = generateX25519Keypair();
  await progress.done('ephemeral', `Ephemeral pubkey ${shorten(base64Encode(eph.publicKey))}`);

  // Step 3: ECDH shared secret = SHA-256(scalarmult)
  await progress.begin('ecdh');
  const rawShared = scalarMult(eph.secretKey, theirVpub);
  const shared = sha256(rawShared);
  await progress.done('ecdh', '32-byte shared secret derived (kept local, never sent)');

  // Step 4-5: derive stealth/claim keys
  await progress.begin('stealth-tag');
  const stealthTag = computeStealthTag(shared);
  const stealthTagHex = toHex(stealthTag);
  await progress.done('stealth-tag', `Tag ${shorten(stealthTagHex, 16, 8)}`);

  await progress.begin('claim-key');
  const claimSecret = computeClaimSecret(shared);
  const claimPub = computeClaimPub(claimSecret);
  await progress.done('claim-key', `Claim pubkey ${shorten(base64Encode(claimPub))}`);

  // Step 6: encrypt amount
  await progress.begin('encrypt-amount');
  const { payload, blinding } = await encryptStealthAmount(shared, inputs.amountRaw);
  await progress.done(
    'encrypt-amount',
    `Ciphertext ${b64Size(payload.ciphertext)} · 12-byte nonce · AES-256-GCM`,
  );

  return {
    ephemeralPubkey: eph.publicKey,
    ephemeralPubkeyB64: base64Encode(eph.publicKey),
    sharedSecret: shared,
    stealthTag,
    stealthTagHex,
    claimSecret,
    claimPub,
    claimPubB64: base64Encode(claimPub),
    amountPayload: payload,
    blinding,
  };
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

export {
  ed25519PkToX25519,
  scalarMult,
  scalarMultBase,
  generateX25519Keypair,
  aesGcmEncrypt,
  aesGcmDecrypt,
};
