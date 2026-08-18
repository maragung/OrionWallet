/**
 * Unlock session — keeps the wallet unlocked across a page reload.
 *
 * The unlocked wallet lives in the Zustand store, i.e. in JS memory, so a
 * reload used to drop it and send the user back to the PIN screen even one
 * second after unlocking. This module persists just enough to rebuild it.
 *
 * WHERE THE SECRETS GO
 *   The serialized wallet is sealed with AES-256-GCM and split across two
 *   stores that fail differently, so neither half is usable alone:
 *     - the sealed bytes go to `sessionStorage`, which is scoped to ONE browser
 *       tab and is dropped when that tab closes;
 *     - the key goes to IndexedDB as a NON-EXTRACTABLE `CryptoKey` — WebCrypto
 *       can decrypt with it, but nothing (not our code, not injected script)
 *       can ever read its bytes back out.
 *   Consequences: a reload restores the session; closing the tab ends it; the
 *   IndexedDB half left on disk decrypts nothing on its own. Without
 *   `crypto.subtle` (insecure context) the key is raw bytes instead — the split
 *   still holds, the non-extractability does not.
 *
 * EXPIRY — matches the session model documented for dApp connections
 *   - idle: 30 min by default, refreshed by real user activity (see
 *     hooks/useAutoLock.ts). Configurable in Settings; 0 disables it.
 *   - absolute: 8 h from the unlock, never extended.
 *   Both are checked on restore, and the idle window is enforced live while the
 *   wallet is open, so "the session has not expired yet" means the same thing
 *   whether or not the page was reloaded.
 *
 * The session is rotated (new key, new nonce, new ciphertext) on every restore,
 * and never written at all when the user turns `keepUnlocked` off in Settings.
 */
import { serializeWallet, deserializeWallet, type Wallet } from './wallet';
import {
  loadSettings,
  putUnlockSessionKey,
  getUnlockSessionKey,
  deleteUnlockSessionKey,
  pruneUnlockSessionKeys,
  type Settings,
} from './storage';
import { aesGcmSeal, aesGcmOpen, generateAesGcmKey, NONCE_LEN } from '../crypto/aes';
import { base64Encode, base64Decode } from '../crypto/base64';
import { randomBytes } from '../crypto/random';
import { hexEncode } from '../crypto/hex';

/** Default idle window: 30 minutes without user activity. */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** Hard cap from the moment of unlock, never extended by activity. */
export const ABS_TTL_MS = 8 * 60 * 60 * 1000;

const STORAGE_KEY = 'orion:unlock-session';
const ENVELOPE_VERSION = 1;

/** What lands in sessionStorage. Holds no key material. */
interface SessionEnvelope {
  v: number;
  /** IndexedDB id of the key that opens `ct`. */
  keyId: string;
  /** Address of the sealed wallet — for diagnostics; not a secret. */
  addr: string;
  /** base64 AES-GCM nonce. */
  iv: string;
  /** base64 sealed `serializeWallet()` output. */
  ct: string;
  createdAt: number;
  lastActiveAt: number;
  /** Idle window in force when the session was minted; 0 = no idle expiry. */
  idleMs: number;
  absMs: number;
}

/**
 * sessionStorage, or null where it is unavailable (some private-browsing modes
 * throw on access). Callers degrade to "no session persistence".
 */
function tabStore(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.sessionStorage;
    // Touch it: Safari in Lockdown/private mode throws only on use.
    const probe = '__orion_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function readEnvelope(): SessionEnvelope | null {
  const store = tabStore();
  if (!store) return null;
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as SessionEnvelope;
    if (env?.v !== ENVELOPE_VERSION || !env.keyId || !env.ct || !env.iv) return null;
    return env;
  } catch {
    return null;
  }
}

function writeEnvelope(env: SessionEnvelope): void {
  tabStore()?.setItem(STORAGE_KEY, JSON.stringify(env));
}

/** True once either expiry window has elapsed. */
function isExpired(env: SessionEnvelope, now = Date.now()): boolean {
  if (now - env.createdAt >= env.absMs) return true;
  return env.idleMs > 0 && now - env.lastActiveAt >= env.idleMs;
}

/** Idle window (ms) implied by the stored settings. 0 means "no idle expiry". */
export function idleMsFromSettings(settings: Pick<Settings, 'autoLockMinutes'> | null): number {
  const minutes = settings?.autoLockMinutes;
  if (minutes === undefined || minutes === null) return DEFAULT_IDLE_MS;
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(minutes) * 60_000;
}

/** Whether the user wants the session to survive a reload (default yes). */
export function keepUnlockedFromSettings(settings: Pick<Settings, 'keepUnlocked'> | null): boolean {
  return settings?.keepUnlocked !== false;
}

/**
 * Cheap synchronous check for "a session might be restorable".
 *
 * Used on first paint to show a restoring state instead of flashing the PIN
 * screen. Reads timestamps only — it never decrypts, so a `true` here can still
 * be followed by a failed `restoreUnlockSession()`.
 */
export function hasUnlockSession(): boolean {
  const env = readEnvelope();
  return !!env && !isExpired(env);
}

/** Wall-clock time the current session expires, or null when there is none. */
export function unlockSessionExpiresAt(): number | null {
  const env = readEnvelope();
  if (!env) return null;
  const abs = env.createdAt + env.absMs;
  if (env.idleMs <= 0) return abs;
  return Math.min(abs, env.lastActiveAt + env.idleMs);
}

/**
 * Seal `wallet` into a new session for this tab.
 *
 * Returns false when no session was written: the user disabled it, or this
 * browser gives us no sessionStorage to write to. `createdAt` is passed through
 * on rotation so refreshing the page can never extend the absolute cap.
 */
export async function saveUnlockSession(
  wallet: Wallet,
  opts: { createdAt?: number; settings?: Settings | null } = {},
): Promise<boolean> {
  const store = tabStore();
  if (!store) return false;

  const settings = opts.settings ?? (await loadSettings().catch(() => null));
  if (!keepUnlockedFromSettings(settings)) {
    await clearUnlockSession();
    return false;
  }

  const now = Date.now();
  const keyId = hexEncode(randomBytes(16));
  const key = await generateAesGcmKey();
  const iv = randomBytes(NONCE_LEN);
  const ct = await aesGcmSeal(serializeWallet(wallet), key, iv);

  // Key first: an envelope whose key is missing is dead weight, the reverse is
  // just an orphan key that the age prune sweeps up.
  await putUnlockSessionKey({ id: keyId, key, createdAt: now });
  writeEnvelope({
    v: ENVELOPE_VERSION,
    keyId,
    addr: wallet.addr,
    iv: base64Encode(iv),
    ct: base64Encode(ct),
    createdAt: opts.createdAt ?? now,
    lastActiveAt: now,
    idleMs: idleMsFromSettings(settings),
    absMs: ABS_TTL_MS,
  });

  // Keys outlive their tab when it closes without locking; sweep the stale ones.
  await pruneUnlockSessionKeys(ABS_TTL_MS).catch(() => undefined);
  return true;
}

/**
 * Re-seal the live session under changed settings, keeping its absolute cap.
 *
 * The idle window and the keep-unlocked switch are stored in settings, so a
 * change only reaches the sealed envelope by minting a new one.
 */
export async function resealUnlockSession(wallet: Wallet, settings: Settings): Promise<boolean> {
  return saveUnlockSession(wallet, { createdAt: readEnvelope()?.createdAt, settings });
}

/**
 * Push the idle deadline out — call on real user activity.
 *
 * Synchronous and sessionStorage-only (no IndexedDB, no crypto), so it is cheap
 * enough to call from input handlers.
 */
export function touchUnlockSession(now = Date.now()): void {
  const env = readEnvelope();
  if (!env) return;
  if (isExpired(env, now)) {
    void clearUnlockSession();
    return;
  }
  env.lastActiveAt = now;
  writeEnvelope(env);
}

/**
 * Rebuild the wallet sealed by this tab's session, or null when there is none,
 * it expired, or it cannot be opened (key gone, tampered ciphertext).
 *
 * Any failure clears the session, so a broken one can never wedge the app on a
 * restoring state — the caller falls through to the PIN screen.
 */
export async function restoreUnlockSession(): Promise<Wallet | null> {
  const env = readEnvelope();
  if (!env) return null;
  if (isExpired(env)) {
    await clearUnlockSession();
    return null;
  }

  try {
    const rec = await getUnlockSessionKey(env.keyId);
    if (!rec) {
      await clearUnlockSession();
      return null;
    }
    const plain = await aesGcmOpen(base64Decode(env.ct), rec.key, base64Decode(env.iv));
    const wallet = deserializeWallet(plain);

    // Rotate: this tab gets a fresh key + ciphertext, and the old key is left
    // for the age prune rather than deleted — another tab (or a /connect popup
    // that inherited a copy of this envelope) may still be pointing at it.
    await saveUnlockSession(wallet, { createdAt: env.createdAt });
    return wallet;
  } catch {
    await clearUnlockSession();
    return null;
  }
}

/** End this tab's session: drop the sealed bytes and destroy the key. */
export async function clearUnlockSession(): Promise<void> {
  const env = readEnvelope();
  tabStore()?.removeItem(STORAGE_KEY);
  if (env) await deleteUnlockSessionKey(env.keyId).catch(() => undefined);
}
