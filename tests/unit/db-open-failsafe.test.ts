import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openDbWithTimeout } from '../../src/wallet/storage';

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
    oldConn?.close();
    oldConn = null;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('orion-wallet');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('rejects instead of hanging when the upgrade is blocked by an old connection', async () => {
    await expect(openDbWithTimeout(300)).rejects.toThrow(/another|blocked/i);
  });

  it('recovers and opens normally once the old connection closes', async () => {
    await expect(openDbWithTimeout(300)).rejects.toThrow();
    oldConn?.close();
    oldConn = null;
    const db = await openDbWithTimeout(500);
    expect(db.objectStoreNames.contains('wallets')).toBe(true);
    expect(db.objectStoreNames.contains('browser-bookmarks')).toBe(true);
    db.close();
  });

  it('resolves promptly when no blocker is present', async () => {
    oldConn?.close();
    oldConn = null;
    const db = await openDbWithTimeout(500);
    expect(db.name).toBe('orion-wallet');
    db.close();
  });
});
