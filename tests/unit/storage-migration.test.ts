import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { openDB } from 'idb';

/**
 * Regression cover for the "webcli-react" → "orion-wallet" rebrand.
 *
 * IndexedDB scopes data by database name, so renaming the database would orphan
 * every existing wallet — users would open the app to an empty state and, worse,
 * might create a new wallet over the top of funds they still owned.
 *
 * `migrateLegacyDatabase` in src/wallet/storage.ts copies the old database
 * forward on first launch. These tests pin the three properties that make that
 * safe: it actually copies, it is idempotent, and it never destroys the source.
 */

const LEGACY_DB = 'webcli-react';
const CURRENT_DB = 'orion-wallet';
const DB_VERSION = 2;

const STORES: { name: string; keyPath: string }[] = [
  { name: 'wallets', keyPath: 'id' },
  { name: 'manifest', keyPath: 'id' },
  { name: 'tx-cache', keyPath: 'key' },
  { name: 'settings', keyPath: 'id' },
  { name: 'sdk-sessions', keyPath: 'sid' },
  { name: 'sdk-trusted-sites', keyPath: 'origin' },
  { name: 'sdk-permissions', keyPath: 'origin' },
];

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/** Build a legacy database holding a representative wallet + settings. */
async function seedLegacyDatabase(): Promise<void> {
  const db = await openDB(LEGACY_DB, DB_VERSION, {
    upgrade(d) {
      for (const { name, keyPath } of STORES) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
      }
    },
  });
  await db.put('wallets', {
    id: 'default',
    blob: new Uint8Array([1, 2, 3, 4, 5]),
    addrHint: 'octTEST…',
    name: 'Legacy wallet',
    createdAt: 1_700_000_000,
  });
  await db.put('manifest', {
    id: 0,
    accounts: [{ addr: 'octLEGACY', name: 'Account 1', index: 0, pubB64: 'cHVi' }],
    activeAddr: 'octLEGACY',
    version: 1,
  });
  await db.put('settings', {
    id: 'settings',
    rpcUrl: 'https://legacy.example/rpc',
    network: 'devnet',
    theme: 'dark',
  });
  await db.put('tx-cache', { key: 'octLEGACY:hash1', tx: { hash: 'hash1' } });
  db.close();
}

/** Re-import storage.ts with a fresh module registry so its singleton resets. */
async function freshStorageModule() {
  const vi = (await import('vitest')).vi;
  vi.resetModules();
  return import('../../src/wallet/storage');
}

describe('legacy database migration (webcli-react → orion-wallet)', () => {
  beforeAll(async () => {
    if (typeof globalThis.indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    await deleteDatabase(LEGACY_DB);
    await deleteDatabase(CURRENT_DB);
  });

  afterEach(async () => {
    await deleteDatabase(LEGACY_DB);
    await deleteDatabase(CURRENT_DB);
  });

  it('copies wallets, manifest, settings and tx-cache forward', async () => {
    await seedLegacyDatabase();

    const storage = await freshStorageModule();
    const db = await storage.getDb();

    const wallet = await db.get('wallets', 'default');
    expect(wallet).toBeDefined();
    expect(wallet.name).toBe('Legacy wallet');
    expect(Array.from(wallet.blob as Uint8Array)).toEqual([1, 2, 3, 4, 5]);

    const manifest = await db.get('manifest', 0);
    expect(manifest.activeAddr).toBe('octLEGACY');
    expect(manifest.accounts).toHaveLength(1);

    const settings = await db.get('settings', 'settings');
    expect(settings.rpcUrl).toBe('https://legacy.example/rpc');

    expect(await db.count('tx-cache')).toBe(1);

    await storage.closeDb();
  });

  it('leaves the legacy database intact so a rollback is possible', async () => {
    await seedLegacyDatabase();

    const storage = await freshStorageModule();
    await storage.getDb();
    await storage.closeDb();

    const legacy = await openDB(LEGACY_DB);
    expect(await legacy.count('wallets')).toBe(1);
    const stillThere = await legacy.get('wallets', 'default');
    expect(stillThere.name).toBe('Legacy wallet');
    legacy.close();
  });

  it('is idempotent — re-opening does not duplicate or clobber data', async () => {
    await seedLegacyDatabase();

    const first = await freshStorageModule();
    const db1 = await first.getDb();
    // Simulate the user renaming their wallet after migrating.
    await db1.put('wallets', {
      id: 'default',
      blob: new Uint8Array([9, 9, 9]),
      addrHint: 'octTEST…',
      name: 'Renamed after migration',
      createdAt: 1_700_000_001,
    });
    await first.closeDb();

    const second = await freshStorageModule();
    const db2 = await second.getDb();
    expect(await db2.count('wallets')).toBe(1);
    const wallet = await db2.get('wallets', 'default');
    // Must NOT be overwritten by the legacy copy on the second open.
    expect(wallet.name).toBe('Renamed after migration');
    await second.closeDb();
  });

  it('is a no-op for a fresh install with no legacy database', async () => {
    const storage = await freshStorageModule();
    const db = await storage.getDb();

    expect(await db.count('wallets')).toBe(0);
    // All stores must still be created.
    for (const { name } of STORES) {
      expect(db.objectStoreNames.contains(name)).toBe(true);
    }
    await storage.closeDb();
  });

  it('does not migrate when the target already holds a wallet', async () => {
    await seedLegacyDatabase();

    // Pre-create the target with its own wallet, as if already in use.
    const target = await openDB(CURRENT_DB, DB_VERSION, {
      upgrade(d) {
        for (const { name, keyPath } of STORES) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
        }
      },
    });
    await target.put('wallets', {
      id: 'default',
      blob: new Uint8Array([7]),
      addrHint: 'octNEW…',
      name: 'Existing wallet',
      createdAt: 1_700_000_002,
    });
    target.close();

    const storage = await freshStorageModule();
    const db = await storage.getDb();
    const wallet = await db.get('wallets', 'default');
    expect(wallet.name).toBe('Existing wallet');
    // The legacy settings must not have leaked in.
    expect(await db.get('settings', 'settings')).toBeUndefined();
    await storage.closeDb();
  });
});
