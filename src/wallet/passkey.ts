/**
 * Passkey unlock — open the wallet with the device's biometric/PIN prompt
 * instead of typing the wallet PIN.
 *
 * HOW IT WORKS
 *   A platform passkey is registered with the WebAuthn **PRF** extension. PRF
 *   lets us ask the authenticator for a pseudo-random 32-byte value derived
 *   from (credential secret, our salt). That value never leaves the
 *   authenticator's control until a successful user-verification gesture, and
 *   it is stable — the same salt always yields the same bytes. We use it as the
 *   sealing key for `serializeWallet()` output and store only the ciphertext.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT
 *   - The stored record holds no key material of its own: without the
 *     authenticator (and a fresh biometric gesture) it decrypts to nothing.
 *   - It DOES mean the device's own unlock gesture becomes an alternative to
 *     the wallet PIN on this browser profile. Anyone who can pass the device
 *     biometric can open the wallet. That is the deal the user opts into.
 *   - The wallet PIN is never stored, so the PIN is still the only way to
 *     export keys, change the PIN, or derive new accounts.
 *   - It is per-browser-profile and per-origin: clearing site data, or moving
 *     to another browser, leaves the PIN as the only way in.
 *
 * PRF is required, not optional: without it we would have to keep a key we
 * could read, which would make the record decryptable on its own. When the
 * authenticator lacks PRF support we refuse rather than downgrade.
 */
import { serializeWallet, deserializeWallet, type Wallet } from './wallet';
import {
  putPasskeyUnlock,
  getPasskeyUnlock,
  deletePasskeyUnlock,
  type PasskeyUnlockRecord,
} from './storage';
import { aesGcmSeal, aesGcmOpen, NONCE_LEN } from '../crypto/aes';
import { base64Encode, base64Decode } from '../crypto/base64';
import { randomBytes } from '../crypto/random';
import { sha256 } from '../crypto/sha256';
import { isWatchOnly } from './watch-only';

/** Domain separator mixed into the PRF output before it is used as a key. */
const KDF_LABEL = 'orion-passkey-unlock-v1';
const RP_NAME = 'Orion Wallet';
const TIMEOUT_MS = 60_000;

// ===== WebAuthn PRF typings =====
// The PRF extension is not in the TS DOM lib yet, so describe just the parts
// we use rather than casting to `any` at every call site.

interface PrfValues {
  first: BufferSource;
  second?: BufferSource;
}
interface PrfInputs {
  eval?: PrfValues;
}
interface PrfResults {
  first?: ArrayBuffer;
  second?: ArrayBuffer;
}
interface PrfOutputs {
  enabled?: boolean;
  results?: PrfResults;
}
type ExtensionInputs = AuthenticationExtensionsClientInputs & { prf?: PrfInputs };
type ExtensionOutputs = AuthenticationExtensionsClientOutputs & { prf?: PrfOutputs };

/** What the UI needs to describe an existing passkey without decrypting it. */
export interface PasskeyInfo {
  addr: string;
  name: string;
  createdAt: number;
}

/**
 * True when this browser can even attempt a passkey.
 *
 * WebAuthn requires a secure context, so plain http:// (other than localhost)
 * is out. This says nothing about PRF support — that is only knowable after a
 * registration attempt, which is why `enablePasskeyUnlock` re-checks.
 */
export function isPasskeySupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  return (
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

/** The registered passkey's account, or null when the feature is off. */
export async function getPasskeyInfo(): Promise<PasskeyInfo | null> {
  const rec = await getPasskeyUnlock().catch(() => null);
  if (!rec) return null;
  return { addr: rec.addr, name: rec.name, createdAt: rec.createdAt };
}

/** Forget the passkey record. The credential itself stays in the OS keychain. */
export async function disablePasskeyUnlock(): Promise<void> {
  await deletePasskeyUnlock();
}

/**
 * Copy into a fresh `ArrayBuffer`.
 *
 * WebAuthn takes `BufferSource`, which TS pins to a plain `ArrayBuffer` while
 * our byte helpers return the wider `ArrayBufferLike`. The copy is a few dozen
 * bytes and settles the difference without a cast.
 */
function asBuffer(b: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return copy;
}

function bytes(src: ArrayBuffer | ArrayBufferView): Uint8Array {
  return src instanceof ArrayBuffer
    ? new Uint8Array(src)
    : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}

/** Turn the PRF output into an AES-256 key, domain-separated from other uses. */
function deriveKey(prf: ArrayBuffer): Uint8Array {
  const label = new TextEncoder().encode(KDF_LABEL);
  const raw = new Uint8Array(prf);
  if (raw.length === 0) throw new Error('The authenticator returned an empty PRF value');
  const input = new Uint8Array(label.length + raw.length);
  input.set(label, 0);
  input.set(raw, label.length);
  return sha256(input);
}

function rpId(): string | undefined {
  // Omitted for non-browser callers; the browser defaults it to the origin.
  if (typeof window === 'undefined') return undefined;
  return window.location.hostname || undefined;
}

/** Human-readable reason a WebAuthn call failed, so toasts are actionable. */
function describeWebAuthnError(e: unknown): string {
  const err = e as DOMException & { message?: string };
  switch (err?.name) {
    case 'NotAllowedError':
      return 'The request was dismissed or timed out';
    case 'InvalidStateError':
      return 'A passkey for this wallet already exists on this device';
    case 'SecurityError':
      return 'This origin is not allowed to use passkeys';
    case 'NotSupportedError':
      return 'This device has no compatible authenticator';
    case 'AbortError':
      return 'The request was cancelled';
    default:
      return err?.message || 'Unknown WebAuthn error';
  }
}

/** Ask an existing credential for its PRF output. Throws when PRF is refused. */
async function evaluatePrf(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
  let assertion: Credential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: asBuffer(randomBytes(32)),
        rpId: rpId(),
        allowCredentials: [{ type: 'public-key', id: asBuffer(credentialId) }],
        userVerification: 'required',
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: asBuffer(salt) } } } as ExtensionInputs,
      },
    });
  } catch (e) {
    throw new Error(describeWebAuthnError(e), { cause: e });
  }
  if (!assertion) throw new Error('No passkey was returned by the browser');

  const out = (assertion as PublicKeyCredential).getClientExtensionResults() as ExtensionOutputs;
  const first = out.prf?.results?.first;
  if (!first) {
    throw new Error(
      'This passkey did not return a PRF value, so it cannot unlock the wallet. ' +
        'Use the wallet PIN, and re-enable passkey unlock on a device that supports the PRF extension.',
    );
  }
  return first;
}

/**
 * Register a passkey and seal `wallet` under the key it derives.
 *
 * Depending on the browser this takes one or two user-verification prompts:
 * one to create the credential, and a second to read its PRF output when the
 * platform declines to evaluate PRF during registration.
 */
export async function enablePasskeyUnlock(wallet: Wallet): Promise<PasskeyInfo> {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys need a secure context (https:// or localhost) and a modern browser');
  }
  if (isWatchOnly(wallet)) {
    throw new Error('Watch-only accounts hold no keys, so there is nothing to unlock');
  }

  const salt = randomBytes(32);
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME, id: rpId() },
        user: {
          id: asBuffer(randomBytes(16)),
          name: wallet.addr,
          displayName: wallet.name || wallet.addr.slice(0, 12),
        },
        challenge: asBuffer(randomBytes(32)),
        // ES256 first, RS256 as the fallback some Windows Hello stacks need.
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          // Not "required": we keep the credential id ourselves, so a
          // non-discoverable credential unlocks just as well and works on
          // authenticators with no room for resident keys.
          residentKey: 'preferred',
          userVerification: 'required',
        },
        timeout: TIMEOUT_MS,
        attestation: 'none',
        extensions: { prf: { eval: { first: asBuffer(salt) } } } as ExtensionInputs,
      },
    });
  } catch (e) {
    throw new Error(`Passkey registration failed: ${describeWebAuthnError(e)}`, { cause: e });
  }
  if (!cred) throw new Error('Passkey registration returned nothing');

  const pk = cred as PublicKeyCredential;
  const created = pk.getClientExtensionResults() as ExtensionOutputs;
  if (created.prf?.enabled === false) {
    throw new Error(
      'This authenticator does not support the PRF extension, which passkey unlock needs. ' +
        'Nothing was changed — keep using your PIN.',
    );
  }

  const credentialId = bytes(pk.rawId);
  // Chrome can evaluate PRF during registration; other platforms need a second
  // gesture. Reuse the registration output when it is there.
  const prf = created.prf?.results?.first ?? (await evaluatePrf(credentialId, salt));

  const key = deriveKey(prf);
  const iv = randomBytes(NONCE_LEN);
  const ct = await aesGcmSeal(serializeWallet(wallet), key, iv);
  key.fill(0);

  const rec: PasskeyUnlockRecord = {
    id: 'default',
    credentialId: base64Encode(credentialId),
    addr: wallet.addr,
    name: wallet.name || 'Account',
    prfSalt: base64Encode(salt),
    iv,
    ct,
    createdAt: Date.now(),
  };
  await putPasskeyUnlock(rec);
  return { addr: rec.addr, name: rec.name, createdAt: rec.createdAt };
}

/**
 * Reproduce the sealed wallet with a biometric gesture.
 *
 * A record that will not open is deleted, so a stale one (credential removed
 * from the OS, site data partially cleared) cannot leave a dead button on the
 * unlock screen forever.
 */
export async function unlockWithPasskey(): Promise<Wallet> {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are unavailable in this browser context');
  }
  const rec = await getPasskeyUnlock();
  if (!rec) throw new Error('Passkey unlock is not set up on this device');

  const prf = await evaluatePrf(base64Decode(rec.credentialId), base64Decode(rec.prfSalt));
  const key = deriveKey(prf);
  try {
    const plain = await aesGcmOpen(rec.ct, key, rec.iv);
    return deserializeWallet(plain);
  } catch {
    await deletePasskeyUnlock().catch(() => undefined);
    throw new Error(
      'The passkey no longer opens this wallet, so passkey unlock has been switched off. Unlock with your PIN.',
    );
  } finally {
    key.fill(0);
  }
}
