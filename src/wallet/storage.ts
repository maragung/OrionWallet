/**
 * IndexedDB storage layer for wallet + manifest + tx cache.
 * Replaces the C++ filesystem + LevelDB layer.
 *
 * Schema:
 *   DB name: "orion-wallet" (legacy: "webcli-react" — see migrateLegacyDatabase)
 *   Object stores:
 *     - wallets:    { id: "default", blob: Uint8Array, addrHint: string, name: string }
 *     - manifest:   { id: 0, accounts: [{addr, name, index, pubB64}] }
 *     - tx-cache:   key by `${addr}:${txHash}`, value = JSON tx
 *     - settings:   { id: "settings", rpcUrl, network, ... }
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { NetworkId, CustomNetworkDef } from './networks';

const DB_NAME = 'orion-wallet';
/** Pre-rebrand database name. Data is copied forward on first launch. */
const LEGACY_DB_NAME = 'webcli-react';
const DB_VERSION = 5;
/** How long an IndexedDB open/upgrade may take before we fail loudly. */
const DB_OPEN_TIMEOUT_MS = 8_000;

/** Every object store, in the order they are created and migrated. */
const OBJECT_STORES: { name: string; keyPath: string }[] = [
  { name: 'wallets', keyPath: 'id' },
  { name: 'manifest', keyPath: 'id' },
  { name: 'tx-cache', keyPath: 'key' },
  { name: 'settings', keyPath: 'id' },
  // v2: Wallet SDK stores (additive migration).
  { name: 'sdk-sessions', keyPath: 'sid' },
  { name: 'sdk-trusted-sites', keyPath: 'origin' },
  { name: 'sdk-permissions', keyPath: 'origin' },
  // v3: OCS01 token stores (additive migration).
  { name: 'token-registry', keyPath: 'id' },
  { name: 'token-holdings', keyPath: 'key' },
  { name: 'token-custom', keyPath: 'key' },
  // v4: oct:// browser bookmarks (additive migration).
  { name: 'browser-bookmarks', keyPath: 'uri' },
  // v5: unlock-session keys (additive migration). Holds the key that seals the
  // unlock session, never the session itself — see wallet/unlock-session.ts.
  { name: 'unlock-session-keys', keyPath: 'id' },
];

export interface StoredWalletEntry {
  id: string; // "default" or addr-hint
  blob: Uint8Array; // encrypted wallet bytes
  addrHint: string; // partial addr for hint (first 8 chars + ...)
  name: string;
  createdAt: number;
}

export interface ManifestEntry {
  addr: string;
  name: string;
  index: number;
  pubB64: string;
  createdAt: number;
}

export interface Manifest {
  id: number; // always 0
  accounts: ManifestEntry[];
  activeAddr: string | null;
  version: number;
}

export interface Settings {
  id: string; // always "settings"
  rpcUrl: string;
  /** 'devnet' | 'mainnet' | <custom network id>. */
  network: NetworkId;
  theme: 'dark' | 'light' | 'system';
  lastUsedAddress?: string;
  explorerUrl?: string;
  language?: string; // LanguageCode
  /** Circle relayer URL for the active network (oct:// compute bridge). */
  relayerUrl?: string;
  /** User-added networks (presets are not stored here). */
  customNetworks?: CustomNetworkDef[];
  /**
   * Keep the wallet unlocked across a page reload (default true).
   * The session never outlives the browser tab — see wallet/unlock-session.ts.
   */
  keepUnlocked?: boolean;
  /** Minutes of inactivity before the wallet locks itself. 0 disables idle lock. */
  autoLockMinutes?: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/** Create any object store that does not yet exist. */
function ensureStores(db: IDBPDatabase): void {
  for (const { name, keyPath } of OBJECT_STORES) {
    if (!db.objectStoreNames.contains(name)) {
      db.createObjectStore(name, { keyPath });
    }
  }
}

/** True if a database of this name already exists (without creating one). */
async function databaseExists(name: string): Promise<boolean> {
  // `indexedDB.databases()` is unavailable in Firefox and older Safari, so fall
  // back to probing: opening at version 1 fires `upgradeneeded` only when the
  // database is new, which we then abort and delete.
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      return list.some((d) => d.name === name);
    } catch {
      // fall through to the probe
    }
  }
  return new Promise((resolve) => {
    let existed = true;
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      // Fired only for a database that did not previously exist.
      existed = false;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      req.result.close();
      if (!existed) indexedDB.deleteDatabase(name);
      resolve(existed);
    };
    req.onerror = () => resolve(existed);
    req.onblocked = () => resolve(existed);
  });
}

/**
 * Copy data from the pre-rebrand database into the current one.
 *
 * The rename from "webcli-react" to "orion-wallet" would otherwise orphan every
 * existing wallet, since IndexedDB scopes data by database name. This runs once
 * on first launch after the rename.
 *
 * Safety properties:
 *   - Idempotent: skipped entirely once the target holds any wallet.
 *   - Non-destructive: the legacy database is left untouched, so a user can roll
 *     back to an older build without losing anything.
 *   - Non-fatal: any failure is logged and swallowed. A migration problem must
 *     never prevent the app from starting.
 */
async function migrateLegacyDatabase(target: IDBPDatabase): Promise<void> {
  try {
    // Already migrated (or a genuinely new install with data)? Nothing to do.
    const existingWallets = await target.count('wallets');
    if (existingWallets > 0) return;

    if (!(await databaseExists(LEGACY_DB_NAME))) return;

    // Open the legacy database WITHOUT a version bump so we never trigger an
    // upgrade on data we only intend to read.
    const legacy = await openDB(LEGACY_DB_NAME);
    try {
      let copied = 0;
      for (const { name } of OBJECT_STORES) {
        if (!legacy.objectStoreNames.contains(name)) continue;
        if (!target.objectStoreNames.contains(name)) continue;

        const rows = await legacy.getAll(name);
        if (rows.length === 0) continue;

        const tx = target.transaction(name, 'readwrite');
        // `put` rather than `add` keeps this safe to re-run.
        await Promise.all(rows.map((row) => tx.store.put(row)));
        await tx.done;
        copied += rows.length;
      }
      if (copied > 0) {
        console.info(
          `[storage] Migrated ${copied} record(s) from "${LEGACY_DB_NAME}" to "${DB_NAME}". ` +
            'The legacy database was left intact as a rollback safety net.',
        );
      }
    } finally {
      legacy.close();
    }
  } catch (err) {
    console.error('[storage] Legacy database migration failed (continuing without it):', err);
  }
}

/**
 * Open the database with a fail-safe: an upgrade (version bump) pending on an
 * old connection — e.g. the app still open in another tab — blocks forever by
 * default, which would wedge every storage call including wallet unlock.
 * Instead, surface a clear error via `blocked` or a timeout, and let later
 * calls retry from scratch.
 */
export function openDbWithTimeout(timeoutMs: number = DB_OPEN_TIMEOUT_MS): Promise<IDBPDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          'IndexedDB open timed out. If the wallet is open in another tab, close it and try again.',
        ),
      );
    }, timeoutMs);

    openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        ensureStores(database);
      },
      blocked() {
        // Another connection (older version, e.g. an old tab) refuses to close:
        // the upgrade cannot proceed. Surface it now instead of hanging.
        if (settled) return;
        settled = true;
        reject(
          new Error(
            'Database upgrade is blocked by another open tab. Close other wallet tabs and try again.',
          ),
        );
      },
    })
      .then((db) => {
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        resolve(db);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => clearTimeout(timer));
  });
}

/** Get (or open) the IndexedDB connection. */
export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await openDbWithTimeout();
      await migrateLegacyDatabase(db);
      return db;
    })().catch((err) => {
      // Let a later call retry instead of caching the rejection forever.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// ===== Wallets store =====

export async function saveWalletEntry(entry: StoredWalletEntry): Promise<void> {
  const db = await getDb();
  await db.put('wallets', entry);
}

export async function loadWalletEntry(id: string = 'default'): Promise<StoredWalletEntry | null> {
  const db = await getDb();
  const entry = await db.get('wallets', id);
  return (entry as StoredWalletEntry) || null;
}

export async function listWalletEntries(): Promise<StoredWalletEntry[]> {
  const db = await getDb();
  const all = await db.getAll('wallets');
  return all as StoredWalletEntry[];
}

export async function deleteWalletEntry(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('wallets', id);
}

// ===== Manifest store =====

export async function loadManifest(): Promise<Manifest> {
  const db = await getDb();
  const m = (await db.get('manifest', 0)) as Manifest | undefined;
  return m ?? { id: 0, accounts: [], activeAddr: null, version: 1 };
}

export async function saveManifest(m: Manifest): Promise<void> {
  const db = await getDb();
  await db.put('manifest', m);
}

export async function addAccountToManifest(entry: ManifestEntry): Promise<Manifest> {
  const m = await loadManifest();
  // Replace if exists (same addr), else append
  const idx = m.accounts.findIndex((a) => a.addr === entry.addr);
  if (idx >= 0) m.accounts[idx] = entry;
  else m.accounts.push(entry);
  if (!m.activeAddr) m.activeAddr = entry.addr;
  await saveManifest(m);
  return m;
}

export async function removeAccountFromManifest(addr: string): Promise<Manifest> {
  const m = await loadManifest();
  m.accounts = m.accounts.filter((a) => a.addr !== addr);
  if (m.activeAddr === addr) {
    m.activeAddr = m.accounts[0]?.addr ?? null;
  }
  await saveManifest(m);
  return m;
}

export async function setActiveAccount(addr: string): Promise<Manifest> {
  const m = await loadManifest();
  if (!m.accounts.find((a) => a.addr === addr)) {
    throw new Error(`setActiveAccount: address ${addr} not in manifest`);
  }
  m.activeAddr = addr;
  await saveManifest(m);
  return m;
}

// ===== Settings store =====

export async function loadSettings(): Promise<Settings> {
  const db = await getDb();
  const s = (await db.get('settings', 'settings')) as Settings | undefined;
  return (
    s ?? {
      id: 'settings',
      rpcUrl: 'https://devnet.octrascan.io/rpc',
      network: 'devnet',
      theme: 'dark',
      explorerUrl: 'https://devnet.octrascan.io',
    }
  );
}

export async function saveSettings(s: Settings): Promise<void> {
  const db = await getDb();
  await db.put('settings', s);
}

/**
 * Merge a partial update into the stored settings.
 *
 * Prefer this over loadSettings + saveSettings when only a subset of fields
 * changes: independent writers (e.g. the language switcher and the network
 * switcher) would otherwise read a snapshot and write it back wholesale,
 * silently reverting each other's changes.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await getDb();
  const current = await loadSettings();
  const next = { ...current, ...patch, id: 'settings' } as Settings;
  await db.put('settings', next);
  return next;
}

// ===== Tx cache store =====

export interface TxCacheEntry {
  key: string; // `${addr}:${txHash}`
  addr: string;
  hash: string;
  tx: unknown; // arbitrary JSON
  receivedAt: number;
}

export async function putTxCache(entry: TxCacheEntry): Promise<void> {
  const db = await getDb();
  await db.put('tx-cache', entry);
}

export async function getTxCache(addr: string, hash: string): Promise<TxCacheEntry | null> {
  const db = await getDb();
  const e = (await db.get('tx-cache', `${addr}:${hash}`)) as TxCacheEntry | undefined;
  return e ?? null;
}

export async function listTxCache(addr: string, limit: number = 100): Promise<TxCacheEntry[]> {
  const db = await getDb();
  const all = (await db.getAll('tx-cache')) as TxCacheEntry[];
  return all
    .filter((e) => e.addr === addr)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, limit);
}

export async function clearTxCache(addr?: string): Promise<void> {
  const db = await getDb();
  if (!addr) {
    await db.clear('tx-cache');
    return;
  }
  const all = (await db.getAll('tx-cache')) as TxCacheEntry[];
  for (const e of all) {
    if (e.addr === addr) await db.delete('tx-cache', e.key);
  }
}

// ===== Wallet SDK: sessions =====

export interface SdkSessionRecord {
  sid: string;
  origin: string;
  address: string;
  accounts: string[];
  network: string;
  chainId: string;
  permissions: string[];
  /**
   * Scopes the user has explicitly revoked. Signing scopes are granted on first
   * approval rather than at connect time, so absence from `permissions` cannot
   * by itself mean "denied" — revocation has to be recorded positively.
   */
  deniedPermissions?: string[];
  createdAt: number;
  lastUsedAt: number;
  /** Idle expiry (ms since epoch). */
  idleExpiresAt: number;
  /** Absolute expiry (ms since epoch). */
  absExpiresAt: number;
}

export async function saveSdkSession(s: SdkSessionRecord): Promise<void> {
  const db = await getDb();
  await db.put('sdk-sessions', s);
}

export async function getSdkSession(sid: string): Promise<SdkSessionRecord | null> {
  const db = await getDb();
  return ((await db.get('sdk-sessions', sid)) as SdkSessionRecord | undefined) ?? null;
}

export async function findSdkSessionByOrigin(origin: string): Promise<SdkSessionRecord | null> {
  const db = await getDb();
  const all = (await db.getAll('sdk-sessions')) as SdkSessionRecord[];
  const now = Date.now();
  const live = all
    .filter((s) => s.origin === origin && s.absExpiresAt > now && s.idleExpiresAt > now)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return live[0] ?? null;
}

export async function listSdkSessions(): Promise<SdkSessionRecord[]> {
  const db = await getDb();
  return (await db.getAll('sdk-sessions')) as SdkSessionRecord[];
}

export async function deleteSdkSession(sid: string): Promise<void> {
  const db = await getDb();
  await db.delete('sdk-sessions', sid);
}

// ===== Wallet SDK: trusted sites =====

export interface TrustedSiteRecord {
  origin: string;
  label?: string;
  addedAt: number;
}

export async function addTrustedSite(rec: TrustedSiteRecord): Promise<void> {
  const db = await getDb();
  await db.put('sdk-trusted-sites', rec);
}

export async function isTrustedSite(origin: string): Promise<boolean> {
  const db = await getDb();
  return !!(await db.get('sdk-trusted-sites', origin));
}

export async function listTrustedSites(): Promise<TrustedSiteRecord[]> {
  const db = await getDb();
  return (await db.getAll('sdk-trusted-sites')) as TrustedSiteRecord[];
}

export async function removeTrustedSite(origin: string): Promise<void> {
  const db = await getDb();
  await db.delete('sdk-trusted-sites', origin);
}

// ===== Wallet SDK: per-origin permissions =====

export interface PermissionRecord {
  origin: string;
  permissions: string[];
  updatedAt: number;
}

export async function savePermissions(rec: PermissionRecord): Promise<void> {
  const db = await getDb();
  await db.put('sdk-permissions', rec);
}

export async function getPermissions(origin: string): Promise<PermissionRecord | null> {
  const db = await getDb();
  return ((await db.get('sdk-permissions', origin)) as PermissionRecord | undefined) ?? null;
}

// ===== OCS01 tokens =====

/**
 * Cached result of `octra_listContracts`, scoped per RPC endpoint.
 *
 * The contract set differs per network (~2k on mainnet, ~6.5k on devnet), so
 * the endpoint URL is part of the key to stop a devnet scan from being reused
 * against mainnet.
 */
export interface TokenRegistryEntry {
  id: string; // rpcUrl
  addresses: string[];
  fetchedAt: number;
}

/**
 * One token holding for one wallet address.
 *
 * `rawBalance` and `totalSupply` are decimal STRINGS, not bigint: IndexedDB
 * cannot structured-clone a BigInt. Callers parse them back with `parseU128`
 * at the boundary — never with Number.
 */
export interface TokenHoldingEntry {
  key: string; // `${rpcUrl}|${ownerAddr}|${contractAddr}`
  rpcUrl: string;
  owner: string;
  contract: string;
  rawBalance: string;
  symbol: string | null;
  name: string | null;
  /** null means the contract exposes no `decimals` key — scaling unknown. */
  decimals: number | null;
  totalSupply: string | null;
  updatedAt: number;
}

/** A token the user added by hand, kept even when its balance is zero. */
export interface TokenCustomEntry {
  key: string; // `${rpcUrl}|${ownerAddr}|${contractAddr}`
  rpcUrl: string;
  owner: string;
  contract: string;
  addedAt: number;
}

/** Composite key for holdings and custom entries. */
export function tokenKey(rpcUrl: string, owner: string, contract: string): string {
  return `${rpcUrl}|${owner}|${contract}`;
}

export async function saveTokenRegistry(entry: TokenRegistryEntry): Promise<void> {
  const db = await getDb();
  await db.put('token-registry', entry);
}

export async function getTokenRegistry(rpcUrl: string): Promise<TokenRegistryEntry | null> {
  const db = await getDb();
  return ((await db.get('token-registry', rpcUrl)) as TokenRegistryEntry | undefined) ?? null;
}

export async function saveTokenHolding(entry: TokenHoldingEntry): Promise<void> {
  const db = await getDb();
  await db.put('token-holdings', entry);
}

export async function listTokenHoldings(
  rpcUrl: string,
  owner: string,
): Promise<TokenHoldingEntry[]> {
  const db = await getDb();
  const all = (await db.getAll('token-holdings')) as TokenHoldingEntry[];
  return all.filter((e) => e.rpcUrl === rpcUrl && e.owner === owner);
}

export async function deleteTokenHolding(
  rpcUrl: string,
  owner: string,
  contract: string,
): Promise<void> {
  const db = await getDb();
  await db.delete('token-holdings', tokenKey(rpcUrl, owner, contract));
}

export async function saveCustomToken(entry: TokenCustomEntry): Promise<void> {
  const db = await getDb();
  await db.put('token-custom', entry);
}

export async function listCustomTokens(rpcUrl: string, owner: string): Promise<TokenCustomEntry[]> {
  const db = await getDb();
  const all = (await db.getAll('token-custom')) as TokenCustomEntry[];
  return all.filter((e) => e.rpcUrl === rpcUrl && e.owner === owner);
}

export async function deleteCustomToken(
  rpcUrl: string,
  owner: string,
  contract: string,
): Promise<void> {
  const db = await getDb();
  await db.delete('token-custom', tokenKey(rpcUrl, owner, contract));
}

// ===== Unlock-session keys =====

/**
 * The key that seals one unlock session.
 *
 * Deliberately split from the sealed session itself, which lives in
 * `sessionStorage`: neither half is usable alone, and the sessionStorage half
 * dies with the browser tab. See wallet/unlock-session.ts for the full model.
 */
export interface UnlockSessionKeyRecord {
  id: string;
  /**
   * Non-extractable AES-GCM `CryptoKey` in a secure context (its bytes can
   * never be read back), raw 32 bytes only where `crypto.subtle` is absent.
   */
  key: CryptoKey | Uint8Array;
  createdAt: number;
}

export async function putUnlockSessionKey(rec: UnlockSessionKeyRecord): Promise<void> {
  const db = await getDb();
  await db.put('unlock-session-keys', rec);
}

export async function getUnlockSessionKey(id: string): Promise<UnlockSessionKeyRecord | null> {
  const db = await getDb();
  return ((await db.get('unlock-session-keys', id)) as UnlockSessionKeyRecord | undefined) ?? null;
}

export async function deleteUnlockSessionKey(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('unlock-session-keys', id);
}

/**
 * Drop session keys older than `maxAgeMs`.
 *
 * A tab closed without locking leaves its key behind (the sealed session it
 * belonged to is already gone with the tab), so keys are pruned by age rather
 * than by reference — another tab may still be using one we cannot see.
 */
export async function pruneUnlockSessionKeys(maxAgeMs: number): Promise<void> {
  const db = await getDb();
  const all = (await db.getAll('unlock-session-keys')) as UnlockSessionKeyRecord[];
  const cutoff = Date.now() - maxAgeMs;
  for (const rec of all) {
    if (!(rec.createdAt > cutoff)) await db.delete('unlock-session-keys', rec.id);
  }
}

// ===== Maintenance =====

export async function wipeEverything(): Promise<void> {
  const db = await getDb();
  // Driven by OBJECT_STORES so a newly added store can never be forgotten here.
  for (const { name } of OBJECT_STORES) {
    if (db.objectStoreNames.contains(name)) await db.clear(name);
  }
}

/** Close the DB connection (for tests). */
export async function closeDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}
