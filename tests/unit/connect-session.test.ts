import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  restoreSession,
  loadLiveSession,
  touchSession,
  endSession,
  isExpired,
  hasPermission,
  DEFAULT_PERMISSIONS,
  IDLE_TTL_MS,
  ABS_TTL_MS,
} from '../../src/connect/session';
import {
  trustSite,
  untrustSite,
  siteIsTrusted,
  isValidOrigin,
} from '../../src/connect/trusted-sites';
import { wipeEverything, type SdkSessionRecord } from '../../src/wallet/storage';

const ORIGIN = 'https://dapp.example';

function baseInput() {
  return {
    origin: ORIGIN,
    address: 'oct1111111111111111111111111111111111111111111',
    accounts: ['oct1111111111111111111111111111111111111111111'],
    network: 'devnet',
    chainId: 'octra:devnet',
  };
}

beforeEach(async () => {
  await wipeEverything();
});

describe('session lifecycle', () => {
  it('creates a session with default permissions and TTLs', async () => {
    const s = await createSession(baseInput());
    expect(s.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(s.permissions).toEqual(DEFAULT_PERMISSIONS);
    expect(s.idleExpiresAt).toBeGreaterThan(Date.now());
    expect(s.absExpiresAt).toBeGreaterThan(s.idleExpiresAt - 1);
    expect(s.absExpiresAt - s.createdAt).toBe(ABS_TTL_MS);
  });

  it('restores a live session by origin', async () => {
    const s = await createSession(baseInput());
    const found = await restoreSession(ORIGIN);
    expect(found?.sid).toBe(s.sid);
  });

  it('does not restore an expired session', async () => {
    const s = await createSession(baseInput());
    // Force-expire by rewinding both TTLs into the past via touch semantics.
    const expired: SdkSessionRecord = {
      ...s,
      idleExpiresAt: Date.now() - 1,
      absExpiresAt: Date.now() - 1,
    };
    // Persist the expired copy.
    const { saveSdkSession } = await import('../../src/wallet/storage');
    await saveSdkSession(expired);
    expect(await restoreSession(ORIGIN)).toBeNull();
    // loadLiveSession also auto-deletes it.
    expect(await loadLiveSession(s.sid)).toBeNull();
  });

  it('isExpired respects both idle and absolute caps', () => {
    const now = Date.now();
    const rec = {
      idleExpiresAt: now + 1000,
      absExpiresAt: now + 1000,
    } as SdkSessionRecord;
    expect(isExpired(rec, now)).toBe(false);
    expect(isExpired({ ...rec, idleExpiresAt: now - 1 } as SdkSessionRecord, now)).toBe(true);
    expect(isExpired({ ...rec, absExpiresAt: now - 1 } as SdkSessionRecord, now)).toBe(true);
  });

  it('touch refreshes idle TTL but never beyond the absolute cap', async () => {
    const s = await createSession(baseInput());
    // Simulate a session near its absolute expiry.
    s.absExpiresAt = Date.now() + 5_000;
    const touched = await touchSession(s);
    expect(touched.idleExpiresAt).toBeLessThanOrEqual(touched.absExpiresAt);
    expect(touched.idleExpiresAt).toBeGreaterThan(Date.now());
    expect(IDLE_TTL_MS).toBeGreaterThan(0);
  });

  it('endSession removes it', async () => {
    const s = await createSession(baseInput());
    await endSession(s.sid);
    expect(await loadLiveSession(s.sid)).toBeNull();
  });

  it('hasPermission checks the granted set', async () => {
    const s = await createSession(baseInput());
    expect(hasPermission(s, 'viewBalance')).toBe(true);
    expect(hasPermission(s, 'doTheImpossible')).toBe(false);
  });
});

describe('trusted sites', () => {
  it('validates origins strictly', () => {
    expect(isValidOrigin('https://a.com')).toBe(true);
    expect(isValidOrigin('http://localhost:5173')).toBe(true);
    expect(isValidOrigin('https://a.com/path')).toBe(false);
    expect(isValidOrigin('ftp://a.com')).toBe(false);
    expect(isValidOrigin('not-a-url')).toBe(false);
  });

  it('adds, checks, and removes a trusted site', async () => {
    expect(await siteIsTrusted(ORIGIN)).toBe(false);
    await trustSite(ORIGIN, 'Demo');
    expect(await siteIsTrusted(ORIGIN)).toBe(true);
    await untrustSite(ORIGIN);
    expect(await siteIsTrusted(ORIGIN)).toBe(false);
  });

  it('rejects trusting an invalid origin', async () => {
    await expect(trustSite('https://a.com/x')).rejects.toThrow();
  });
});
