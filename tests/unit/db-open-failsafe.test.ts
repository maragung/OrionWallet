import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  DB_OPEN_BUDGET_MS,
  DbOpenError,
  closeDb,
  getDb,
  openDbWithTimeout,
} from '../../src/wallet/storage';
import { WALLET_READ_TIMEOUT_MS } from '../../src/api/wallet-api';

const deleteDb = (name: string): Promise<void> =>
  new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });

/**
 * A v3-era connection that never closes simulates the failure mode that wedges
 * unlock after a version bump: the upgrade request blocks forever.
 * openDbWithTimeout must surface an error instead of hanging.
 */
describe('IndexedDB open fail-safe', () => {
  let oldConn: IDBDatabase | null = null;

  beforeEach(async () => {
    oldConn = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('orion-wallet');
      req.onsuccess = () => {
        const open = indexedDB.open('orion-wallet', 1);
        open.onupgradeneeded = () => {
          // v1 with no stores is enough to pin an old-version connection.
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('cleanup blocked'));
    });
  });

  afterEach(async () => {
    // Order matters: releasing the blocker first lets any request still queued
    // inside the browser complete, so closeDb can actually close it and the
    // delete below is not blocked by a connection this module still owns.
    oldConn?.close();
    oldConn = null;
    await closeDb();
    await deleteDb('orion-wallet');
    await deleteDb('webcli-react');
  });

  it('rejects instead of hanging when the upgrade is blocked by an old connection', async () => {
    const err = await openDbWithTimeout(300).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbOpenError);
    expect((err as DbOpenError).reason).toBe('blocked');
    expect((err as Error).message).toMatch(/another|blocked/i);
  });

  it('recovers and opens normally once the old connection closes', async () => {
    await expect(openDbWithTimeout(300)).rejects.toThrow();
    oldConn?.close();
    oldConn = null;
    // Generous budget: the assertion is that it opens, not how fast. A tight
    // budget here turns a loaded CI machine into a false failure.
    const db = await openDbWithTimeout(5_000);
    expect(db.objectStoreNames.contains('wallets')).toBe(true);
    expect(db.objectStoreNames.contains('browser-bookmarks')).toBe(true);
    db.close();
  });

  it('waits on the queued request instead of stacking a second one', async () => {
    // The regression: an abandoned open request stays queued in the browser and
    // a new one queues *behind* it, so every retry timed out even after the
    // blocking tab went away. The retry must attach to the same request.
    const open = vi.spyOn(indexedDB, 'open');
    try {
      await expect(openDbWithTimeout(300)).rejects.toThrow();
      oldConn?.close();
      oldConn = null;
      const db = await openDbWithTimeout(5_000);
      db.close();
      const walletOpens = open.mock.calls.filter((c) => c[0] === 'orion-wallet');
      expect(walletOpens).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it('resolves promptly when no blocker is present', async () => {
    oldConn?.close();
    oldConn = null;
    const db = await openDbWithTimeout(5_000);
    expect(db.name).toBe('orion-wallet');
    db.close();
  });

  it('getDb heals itself when the blocking tab closes mid-attempt', async () => {
    // What the user actually does: sees the error, closes the other tab. Nothing
    // should need reloading — the queued upgrade completes and getDb resolves.
    setTimeout(() => {
      oldConn?.close();
      oldConn = null;
    }, 150);
    const db = await getDb();
    expect(db.objectStoreNames.contains('manifest')).toBe(true);
  });

  it('steps aside so another tab can upgrade instead of deadlocking it', async () => {
    oldConn?.close();
    oldConn = null;
    await getDb();

    // A newer build in another tab bumps the version. Our connection must close
    // itself on `versionchange`, or that tab hangs — which is the deadlock users
    // reported as "IndexedDB open timed out".
    const next = await new Promise<IDBDatabase>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('upgrade never completed')), 4_000);
      const req = indexedDB.open('orion-wallet', 99);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('probe-v99', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        clearTimeout(guard);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(guard);
        reject(req.error ?? new Error('upgrade failed'));
      };
      req.onblocked = () => {
        clearTimeout(guard);
        reject(new Error('upgrade blocked by the wallet connection'));
      };
    });
    expect(next.objectStoreNames.contains('probe-v99')).toBe(true);
    next.close();
  });

  it('closeDb returns even while an open request is still queued', async () => {
    // The retry button calls closeDb first. With a blocker in place the request
    // cannot land, and awaiting it forever would freeze the very button meant to
    // recover from the freeze.
    void openDbWithTimeout(100).catch(() => undefined);
    await expect(closeDb()).resolves.toBeUndefined();
  });

  it('bounds a wallet read generously enough for the open to retry', () => {
    // A read deadline shorter than the open budget cuts off the retries that
    // would have recovered the connection, and reports failure instead.
    expect(WALLET_READ_TIMEOUT_MS).toBeGreaterThan(DB_OPEN_BUDGET_MS);
  });
});
