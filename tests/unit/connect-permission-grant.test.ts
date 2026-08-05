import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  grantPermission,
  revokePermission,
  hasPermission,
  DEFAULT_PERMISSIONS,
  SIGNING_PERMISSIONS,
} from '../../src/connect/session';
import { wipeEverything } from '../../src/wallet/storage';

/**
 * Regression cover for the "connect works but nothing else does" symptom.
 *
 * The original implementation granted only read-only scopes at connect time and
 * rejected every signing call with UNAUTHORIZED before the approval prompt could
 * ever appear. This was the second root cause of the symptom: handshake
 * succeeded, but `signMessage`, `signContract`, etc. all failed immediately with
 * a permission error rather than showing the user an approval dialog.
 *
 * The fix: signing scopes are granted lazily on first successful approval and
 * then persisted, so the permission check no longer rejects them. Approval is
 * still required every time — granting a scope only records that the user has
 * agreed the dApp may ask at all.
 */

const ORIGIN = 'https://dapp.example';

beforeEach(async () => {
  await wipeEverything();
});

describe('SDK permission grant flow (lazy signing scopes)', () => {
  it('DEFAULT_PERMISSIONS includes only read-only scopes', () => {
    expect(DEFAULT_PERMISSIONS).toContain('connect');
    expect(DEFAULT_PERMISSIONS).toContain('viewAccounts');
    expect(DEFAULT_PERMISSIONS).toContain('viewBalance');
    expect(DEFAULT_PERMISSIONS).toContain('viewNetwork');
    // Signing scopes are deliberately absent.
    for (const s of SIGNING_PERMISSIONS) {
      expect(DEFAULT_PERMISSIONS).not.toContain(s);
    }
  });

  it('SIGNING_PERMISSIONS enumerates every signing scope', () => {
    const expected = ['signMessage', 'signTypedData', 'approveContract', 'signContract'];
    expect([...SIGNING_PERMISSIONS]).toEqual(expected);
  });

  it('a fresh session has no signing scope', async () => {
    const session = await createSession({
      origin: ORIGIN,
      address: 'octABC',
      accounts: ['octABC'],
      network: 'devnet',
      chainId: 'octra:devnet',
    });
    for (const s of SIGNING_PERMISSIONS) {
      expect(hasPermission(session, s)).toBe(false);
    }
  });

  it('grantPermission adds a signing scope to the session', async () => {
    let session = await createSession({
      origin: ORIGIN,
      address: 'octABC',
      accounts: ['octABC'],
      network: 'devnet',
      chainId: 'octra:devnet',
    });
    expect(hasPermission(session, 'signMessage')).toBe(false);
    session = await grantPermission(session, 'signMessage');
    expect(hasPermission(session, 'signMessage')).toBe(true);
  });

  it('grantPermission is idempotent', async () => {
    let session = await createSession({
      origin: ORIGIN,
      address: 'octABC',
      accounts: ['octABC'],
      network: 'devnet',
      chainId: 'octra:devnet',
    });
    session = await grantPermission(session, 'signMessage');
    const perms1 = session.permissions.slice();
    session = await grantPermission(session, 'signMessage');
    expect(session.permissions).toEqual(perms1);
  });

  it('granting one signing scope does not grant the others', async () => {
    let session = await createSession({
      origin: ORIGIN,
      address: 'octABC',
      accounts: ['octABC'],
      network: 'devnet',
      chainId: 'octra:devnet',
    });
    session = await grantPermission(session, 'signMessage');
    expect(hasPermission(session, 'signMessage')).toBe(true);
    expect(hasPermission(session, 'signContract')).toBe(false);
  });

  it('revokePermission removes a scope and records it in deniedPermissions', async () => {
    let session = await createSession({
      origin: ORIGIN,
      address: 'octABC',
      accounts: ['octABC'],
      network: 'devnet',
      chainId: 'octra:devnet',
    });
    session = await grantPermission(session, 'signMessage');
    expect(hasPermission(session, 'signMessage')).toBe(true);
    expect(session.deniedPermissions).toBeUndefined();

    session = await revokePermission(session, 'signMessage');
    expect(hasPermission(session, 'signMessage')).toBe(false);
    expect(session.deniedPermissions).toContain('signMessage');
  });

  it('grantPermission clears a prior revocation', async () => {
    let session = await createSession({
      origin: ORIGIN,
      address: 'octABC',
      accounts: ['octABC'],
      network: 'devnet',
      chainId: 'octra:devnet',
    });
    session = await grantPermission(session, 'signMessage');
    session = await revokePermission(session, 'signMessage');
    expect(session.deniedPermissions).toContain('signMessage');

    session = await grantPermission(session, 'signMessage');
    expect(hasPermission(session, 'signMessage')).toBe(true);
    expect(session.deniedPermissions).not.toContain('signMessage');
  });
});
