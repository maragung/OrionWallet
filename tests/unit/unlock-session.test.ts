/**
 * Unlock session — the thing that keeps a refresh from re-asking for the PIN.
 *
 * Covers the two properties that matter: a live session comes back intact, and
 * anything less than a live session (expired, key gone, tampered) comes back as
 * "locked" with the leftovers cleaned up rather than half-restored.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ABS_TTL_MS,
  DEFAULT_IDLE_MS,
  clearUnlockSession,
  hasUnlockSession,
  idleMsFromSettings,
  keepUnlockedFromSettings,
  restoreUnlockSession,
  saveUnlockSession,
  touchUnlockSession,
  unlockSessionExpiresAt,
} from '../../src/wallet/unlock-session';
import { getUnlockSessionKey, saveSettings, type Settings } from '../../src/wallet/storage';
import type { Wallet } from '../../src/wallet/wallet';
import { base64Encode } from '../../src/crypto/base64';

const STORAGE_KEY = 'orion:unlock-session';

const BASE_SETTINGS: Settings = {
  id: 'settings',
  rpcUrl: 'https://devnet.octrascan.io/rpc',
  network: 'devnet',
  theme: 'dark',
  keepUnlocked: true,
  autoLockMinutes: 30,
};

function makeWallet(): Wallet {
  const sk = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
  const pk = sk.subarray(32);
  return {
    addr: 'oct1testtesttesttesttesttesttesttesttesttesttest',
    sk,
    pk,
    pubB64: base64Encode(pk),
    privB64: base64Encode(sk.subarray(0, 32)),
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon art',
    hdMaster: new Uint8Array(64).fill(9),
    name: 'Account 0',
    index: 0,
    hdVersion: 2,
    createdAt: 1_700_000_000_000,
  };
}

/** The envelope shape as sessionStorage holds it (mirrors unlock-session.ts). */
interface RawEnvelope {
  v: number;
  keyId: string;
  addr: string;
  iv: string;
  ct: string;
  createdAt: number;
  lastActiveAt: number;
  idleMs: number;
  absMs: number;
}

/** Read the raw envelope the way sessionStorage holds it. */
function envelope(): RawEnvelope | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as RawEnvelope) : null;
}

/** Backdate the envelope's clocks to simulate time passing. */
function ageEnvelope(patch: { createdAt?: number; lastActiveAt?: number }): void {
  const env = envelope();
  if (!env) throw new Error('no envelope to age');
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...env, ...patch }));
}

beforeEach(async () => {
  sessionStorage.clear();
  await saveSettings({ ...BASE_SETTINGS });
});

describe('unlock session', () => {
  it('restores the sealed wallet after a reload', async () => {
    const w = makeWallet();
    expect(await saveUnlockSession(w)).toBe(true);
    expect(hasUnlockSession()).toBe(true);

    const restored = await restoreUnlockSession();
    expect(restored).not.toBeNull();
    expect(restored!.addr).toBe(w.addr);
    expect(restored!.privB64).toBe(w.privB64);
    expect(restored!.mnemonic).toBe(w.mnemonic);
    expect(Array.from(restored!.sk)).toEqual(Array.from(w.sk));
    expect(Array.from(restored!.hdMaster)).toEqual(Array.from(w.hdMaster));
    expect(restored!.name).toBe(w.name);
    expect(restored!.index).toBe(w.index);
  });

  it('keeps no plaintext in sessionStorage', async () => {
    const w = makeWallet();
    await saveUnlockSession(w);
    const raw = sessionStorage.getItem(STORAGE_KEY)!;
    expect(raw).not.toContain(w.privB64);
    expect(raw).not.toContain(w.mnemonic);
    expect(raw).not.toContain(base64Encode(w.sk));
  });

  it('rotates key and ciphertext on restore without extending the absolute cap', async () => {
    const w = makeWallet();
    await saveUnlockSession(w);
    const before = envelope()!;

    // Pretend the session was minted an hour ago, then reload.
    const createdAt = Date.now() - 60 * 60 * 1000;
    ageEnvelope({ createdAt });
    expect(await restoreUnlockSession()).not.toBeNull();

    const after = envelope()!;
    expect(after.keyId).not.toBe(before.keyId);
    expect(after.ct).not.toBe(before.ct);
    expect(after.iv).not.toBe(before.iv);
    // A refresh must not buy another 8 hours.
    expect(after.createdAt).toBe(createdAt);
    // The previous key stays behind for other tabs; the age prune sweeps it.
    expect(await getUnlockSessionKey(before.keyId)).not.toBeNull();
  });

  it('expires after the idle window and clears itself', async () => {
    await saveUnlockSession(makeWallet());
    ageEnvelope({ lastActiveAt: Date.now() - DEFAULT_IDLE_MS - 1000 });

    expect(hasUnlockSession()).toBe(false);
    expect(await restoreUnlockSession()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('expires at the absolute cap even while the user is active', async () => {
    await saveUnlockSession(makeWallet());
    ageEnvelope({ createdAt: Date.now() - ABS_TTL_MS - 1000, lastActiveAt: Date.now() });

    expect(hasUnlockSession()).toBe(false);
    expect(await restoreUnlockSession()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('pushes the idle deadline out on activity', async () => {
    await saveUnlockSession(makeWallet());
    // 29 minutes idle: still alive, one minute from the cliff.
    const nearlyIdle = Date.now() - (DEFAULT_IDLE_MS - 60_000);
    ageEnvelope({ lastActiveAt: nearlyIdle });
    const beforeExpiry = unlockSessionExpiresAt()!;

    touchUnlockSession(Date.now());

    expect(unlockSessionExpiresAt()!).toBeGreaterThan(beforeExpiry);
    expect(hasUnlockSession()).toBe(true);
  });

  it('does not resurrect an expired session on touch', async () => {
    await saveUnlockSession(makeWallet());
    ageEnvelope({ lastActiveAt: Date.now() - DEFAULT_IDLE_MS - 1000 });

    touchUnlockSession(Date.now());

    expect(hasUnlockSession()).toBe(false);
  });

  it('stays locked when the IndexedDB key is gone', async () => {
    await saveUnlockSession(makeWallet());
    // Losing the other half (cleared site data, different profile) must fail
    // closed, not throw.
    await clearIdbKeyOnly();

    expect(await restoreUnlockSession()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('stays locked when the ciphertext was tampered with', async () => {
    await saveUnlockSession(makeWallet());
    const env = envelope()!;
    const flipped = env.ct.startsWith('A') ? `B${env.ct.slice(1)}` : `A${env.ct.slice(1)}`;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...env, ct: flipped }));

    expect(await restoreUnlockSession()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('writes nothing when the user turned keep-unlocked off', async () => {
    await saveSettings({ ...BASE_SETTINGS, keepUnlocked: false });

    expect(await saveUnlockSession(makeWallet())).toBe(false);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(hasUnlockSession()).toBe(false);
  });

  it('drops an existing session when keep-unlocked is turned off', async () => {
    await saveUnlockSession(makeWallet());
    const keyId = envelope()!.keyId;

    await saveSettings({ ...BASE_SETTINGS, keepUnlocked: false });
    await saveUnlockSession(makeWallet());

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await getUnlockSessionKey(keyId)).toBeNull();
  });

  it('honours a custom idle window', async () => {
    await saveSettings({ ...BASE_SETTINGS, autoLockMinutes: 5 });
    await saveUnlockSession(makeWallet());

    // Six minutes idle is fine under the 30-minute default, dead under 5.
    ageEnvelope({ lastActiveAt: Date.now() - 6 * 60_000 });
    expect(hasUnlockSession()).toBe(false);
  });

  it('never expires on idle when auto-lock is disabled', async () => {
    await saveSettings({ ...BASE_SETTINGS, autoLockMinutes: 0 });
    await saveUnlockSession(makeWallet());

    ageEnvelope({ lastActiveAt: Date.now() - 24 * 60 * 60 * 1000 });
    expect(hasUnlockSession()).toBe(true);
    // …but the absolute cap still ends it.
    ageEnvelope({ createdAt: Date.now() - ABS_TTL_MS - 1 });
    expect(hasUnlockSession()).toBe(false);
  });

  it('destroys both halves on clear', async () => {
    await saveUnlockSession(makeWallet());
    const keyId = envelope()!.keyId;

    await clearUnlockSession();

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await getUnlockSessionKey(keyId)).toBeNull();
    expect(hasUnlockSession()).toBe(false);
    expect(await restoreUnlockSession()).toBeNull();
  });
});

describe('session policy from settings', () => {
  it('maps autoLockMinutes to an idle window', () => {
    expect(idleMsFromSettings(null)).toBe(DEFAULT_IDLE_MS);
    expect(idleMsFromSettings({ autoLockMinutes: undefined })).toBe(DEFAULT_IDLE_MS);
    expect(idleMsFromSettings({ autoLockMinutes: 15 })).toBe(15 * 60_000);
    expect(idleMsFromSettings({ autoLockMinutes: 0 })).toBe(0);
    expect(idleMsFromSettings({ autoLockMinutes: -5 })).toBe(0);
    expect(idleMsFromSettings({ autoLockMinutes: Number.NaN })).toBe(0);
  });

  it('keeps sessions unless explicitly disabled', () => {
    expect(keepUnlockedFromSettings(null)).toBe(true);
    expect(keepUnlockedFromSettings({ keepUnlocked: undefined })).toBe(true);
    expect(keepUnlockedFromSettings({ keepUnlocked: true })).toBe(true);
    expect(keepUnlockedFromSettings({ keepUnlocked: false })).toBe(false);
  });
});

/** Delete the IndexedDB key while leaving the sealed bytes in place. */
async function clearIdbKeyOnly(): Promise<void> {
  const { deleteUnlockSessionKey } = await import('../../src/wallet/storage');
  await deleteUnlockSessionKey(envelope()!.keyId);
}
