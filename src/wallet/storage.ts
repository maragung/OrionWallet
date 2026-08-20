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
 *     - contacts:   { addr, name, note?, ... }        (address book)
 *     - passkey-unlock: { id: "default", credentialId, iv, ct, ... }
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { NetworkId, CustomNetworkDef } from './networks';

const DB_NAME = 'orion-wallet';
/** Pre-rebrand database name. Data is copied forward on first launch. */
const LEGACY_DB_NAME = 'webcli-react';
const DB_VERSION = 7;
/** How long the first IndexedDB open/upgrade attempt may take. */
const DB_OPEN_TIMEOUT_MS = 8_000;
/** Deadline for each retry after the first attempt. */
const DB_OPEN_RETRY_TIMEOUT_MS = 3_000;
/** Total open attempts before the failure is reported to the user. */
const DB_OPEN_ATTEMPTS = 3;
/** Pause between open attempts. */
const DB_OPEN_RETRY_DELAY_MS = 250;
/** Cap on the "does this database exist?" probe used by the legacy migration. */
const DB_PROBE_TIMEOUT_MS = 2_000;
/** How long start-up waits for the one-time legacy migration before moving on. */
const LEGACY_MIGRATION_TIMEOUT_MS = 5_000;
/** How long closeDb waits for the connection it is closing. */
const DB_CLOSE_WAIT_MS = 1_000;

/**
 * Worst case time `getDb()` can spend before it gives up: every attempt plus the
 * pauses between them. Callers that bound their own storage reads must allow at
 * least this much, or their deadline fires first and the retries that would have
 * recovered the open never happen.
 */
export const DB_OPEN_BUDGET_MS =
  DB_OPEN_TIMEOUT_MS + (DB_OPEN_ATTEMPTS - 1) * (DB_OPEN_RETRY_TIMEOUT_MS + DB_OPEN_RETRY_DELAY_MS);

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
  // v6: address book + passkey unlock (additive migration).
  { name: 'contacts', keyPath: 'addr' },
  { name: 'passkey-unlock', keyPath: 'id' },
  // v7: token discovery bookkeeping (additive migration). Records when a full
  // balance sweep last completed per (endpoint, address) so discovery can run
  // automatically without re-sweeping on every visit.
  { name: 'token-scans', keyPath: 'key' },
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
  /**
   * Watch-only accounts hold no keys: there is no encrypted wallet blob behind
   * them, so they can be opened without a PIN and can never sign. Absent on
   * every normal account.
   */
  watchOnly?: boolean;
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
  /**
   * `http://` origins the user has explicitly trusted for RPC, e.g.
   * `http://10.0.0.5:8080`. Loopback needs no entry. See wallet/endpoint-policy.ts
   * for the other two things that must also permit an http endpoint.
   */
  allowedInsecureOrigins?: string[];
  /**
   * Optional CORS/TLS-terminating proxy prefix for RPC, e.g.
   * `https://proxy.example.com/?url=`. The endpoint URL is appended
   * percent-encoded, so the browser only ever connects to the proxy.
   */
  rpcProxyUrl?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * The open request currently in flight, if any.
 *
 * IndexedDB cannot cancel an open request. One we stopped waiting for is still
 * queued inside the browser, and a *new* request for the same database queues
 * behind it — so "retry by opening again" guaranteed a second timeout even after
 * the original blocker went away. Callers attach to this single request instead,
 * and only a settled request is ever replaced.
 */
let pendingOpen: Promise<IDBPDatabase> | null = null;
/** Identity of the in-flight request, so a stale settle cannot clear a newer one. */
let openToken: object | null = null;
/** Set when the in-flight request reported `blocked` (another tab holds the DB). */
let openBlocked = false;

/** Why a database open failed. */
export type DbOpenFailureReason = 'timeout' | 'blocked' | 'error';

/**
 * A failed database open, tagged with its reason so callers can react instead of
 * pattern-matching the message: only 'blocked' asks something of the user (close
 * the other tab), and only the others are worth retrying on our own.
 */
export class DbOpenError extends Error {
  readonly reason: DbOpenFailureReason;

  constructor(reason: DbOpenFailureReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DbOpenError';
    this.reason = reason;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve when `p` settles or after `ms`, whichever comes first. Never rejects. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    const finish = (value?: T): void => {
      clearTimeout(timer);
      resolve(value);
    };
    p.then(finish, () => finish());
  });
}

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
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // The probe is an open request of its own, so it can be queued behind an
    // upgrade and never answer. Assume "exists" and move on rather than let a
    // best-effort migration check hold up start-up.
    const timer = setTimeout(() => finish(existed), DB_PROBE_TIMEOUT_MS);
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      // Fired only for a database that did not previously exist.
      existed = false;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      req.result.close();
      if (!existed) indexedDB.deleteDatabase(name);
      finish(existed);
    };
    req.onerror = () => finish(existed);
    req.onblocked = () => finish(existed);
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

/** Forget the cached connection so the next call opens a fresh one. */
function forgetDb(): void {
  dbPromise = null;
  pendingOpen = null;
  openToken = null;
}

/**
 * Start — or join — the single open request for the wallet database.
 *
 * Every connection registers `blocking` and `terminated`: a wallet tab that
 * keeps an older version open is precisely what blocks the next build's upgrade
 * forever, and that deadlock is what this whole path exists to prevent.
 */
function openRequest(): Promise<IDBPDatabase> {
  if (pendingOpen) return pendingOpen;

  const token = {};
  openToken = token;
  openBlocked = false;
  let opened: IDBPDatabase | null = null;

  const clear = (): void => {
    if (openToken !== token) return;
    openToken = null;
    pendingOpen = null;
  };

  const request = openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      ensureStores(database);
    },
    blocked() {
      // An older connection (another wallet tab, or the /connect popup) has not
      // closed yet, so the upgrade cannot start. That is neither fatal nor
      // final: the request stays queued and completes the moment the other tab
      // lets go. Record it and let the deadline decide when to give up.
      openBlocked = true;
      console.warn(
        '[storage] IndexedDB upgrade is waiting for another Orion tab to close its connection.',
      );
    },
    blocking() {
      // Now we are the old connection and another tab wants to upgrade. Closing
      // is the only way it can proceed, and the next storage call reopens at the
      // new version. Holding on is exactly the deadlock users see as
      // "IndexedDB open timed out".
      console.info('[storage] Closing the IndexedDB connection so another tab can upgrade.');
      // Only this request's own bookkeeping: a newer open may already be in
      // flight, and clearing that one would start the duplicate request this
      // module goes out of its way to avoid.
      dbPromise = null;
      clear();
      opened?.close();
    },
    terminated() {
      // The browser dropped the connection (storage eviction, tab discard), so
      // forget it: the next call must reopen instead of using a dead handle.
      console.warn('[storage] IndexedDB connection was terminated by the browser; will reopen.');
      forgetDb();
    },
  });

  const tracked = request.then(
    (db) => {
      opened = db;
      clear();
      return db;
    },
    (err: unknown) => {
      clear();
      throw new DbOpenError(
        'error',
        `Opening the wallet database failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    },
  );
  pendingOpen = tracked;
  return tracked;
}

/**
 * Open the database with a fail-safe: an upgrade (version bump) pending on an
 * old connection — e.g. the app still open in another tab — blocks forever by
 * default, which would wedge every storage call including wallet unlock.
 * Instead, surface a clear error once the deadline passes, and let later calls
 * retry from scratch.
 *
 * Giving up here does not cancel the request (see `pendingOpen`): a later call
 * waits on that same request, which is why a retry succeeds the instant the
 * blocking tab goes away.
 */
export function openDbWithTimeout(timeoutMs: number = DB_OPEN_TIMEOUT_MS): Promise<IDBPDatabase> {
  const request = openRequest();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        openBlocked
          ? new DbOpenError(
              'blocked',
              'Database upgrade is blocked by another open tab. Close other wallet tabs and try again.',
            )
          : new DbOpenError(
              'timeout',
              'IndexedDB open timed out. If the wallet is open in another tab, close it and try again.',
            ),
      );
    }, timeoutMs);

    request
      .then((db) => {
        // The deadline already won. Leave the connection alone: closing it here
        // could yank the handle out from under another caller that attached to
        // this same request and did resolve with it.
        if (settled) return;
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

/**
 * Open the database, retrying the failures a retry can actually fix.
 *
 * One timeout is not evidence of a broken database: a cold profile, a busy disk,
 * a transient backing-store error, or a tab that closed a moment too late all
 * produce one. Without this loop that single failure reached the user as "no
 * stored wallet found", which reads as data loss.
 */
async function openWithRetry(): Promise<IDBPDatabase> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DB_OPEN_ATTEMPTS; attempt += 1) {
    try {
      return await openDbWithTimeout(attempt === 1 ? DB_OPEN_TIMEOUT_MS : DB_OPEN_RETRY_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      // Only the user can clear a blocked upgrade, by closing the other tab, so
      // more attempts would just delay telling them so.
      const blocked = err instanceof DbOpenError && err.reason === 'blocked';
      if (blocked || attempt === DB_OPEN_ATTEMPTS) break;
      console.warn(`[storage] IndexedDB open attempt ${attempt} failed; retrying.`, err);
      await delay(DB_OPEN_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Get (or open) the IndexedDB connection. */
export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    const attempt: Promise<IDBPDatabase> = (async () => {
      const db = await openWithRetry();
      // A slow or wedged migration must not hold up the wallet. It is
      // idempotent and `put`-based, so letting it finish in the background is
      // safe, and never starting the app is not.
      const migrated = await Promise.race([
        migrateLegacyDatabase(db).then(() => true),
        delay(LEGACY_MIGRATION_TIMEOUT_MS).then(() => false),
      ]);
      if (!migrated) {
        console.warn('[storage] Legacy migration is still running; continuing without waiting.');
      }
      return db;
    })().catch((err: unknown) => {
      // Let a later call retry instead of caching the rejection forever.
      if (dbPromise === attempt) dbPromise = null;
      throw err;
    });
    dbPromise = attempt;
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
  /**
   * Deployer of `addresses[i]`, same length and order.
   *
   * Optional because entries cached before this field existed have none; a
   * reader that finds it missing simply loses the deployer fast-path, which is
   * an optimisation rather than a correctness requirement.
   */
  owners?: string[];
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
  /**
   * This owner deployed the contract (it is the `owner` in `listContracts`).
   *
   * Kept because a token you deployed is yours to see even at zero balance —
   * the same reason a hand-added token survives a zero.
   */
  deployed?: boolean;
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

/**
 * Bookkeeping for the full balance sweep, per endpoint and address.
 *
 * `completedAt` only advances when a sweep read every contract. That
 * distinction is the whole point of the record: a sweep that lost chunks to
 * rate limiting has NOT proven the address holds nothing more, so it must not
 * suppress the next attempt.
 */
export interface TokenScanEntry {
  key: string; // `${rpcUrl}|${ownerAddr}`
  rpcUrl: string;
  owner: string;
  /** When the most recent sweep finished, complete or not. */
  attemptedAt: number;
  /**
   * When a sweep last read EVERY contract successfully.
   *
   * A partial sweep leaves this at its previous value, so the next visit tries
   * again instead of trusting an answer that was never fully gathered.
   */
  completedAt: number | null;
  /** Contracts the sweep covered, for progress reporting and diagnostics. */
  contractCount: number;
  /** Contracts whose balance could not be read on the last attempt. */
  unreadable: number;
}

/** Composite key for the scan record. */
export function scanKey(rpcUrl: string, owner: string): string {
  return `${rpcUrl}|${owner}`;
}

export async function saveTokenScan(entry: TokenScanEntry): Promise<void> {
  const db = await getDb();
  await db.put('token-scans', entry);
}

export async function getTokenScan(rpcUrl: string, owner: string): Promise<TokenScanEntry | null> {
  const db = await getDb();
  return (
    ((await db.get('token-scans', scanKey(rpcUrl, owner))) as TokenScanEntry | undefined) ?? null
  );
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

// ===== Address book =====

/**
 * One saved recipient.
 *
 * Keyed by address, so saving the same address twice updates the label instead
 * of creating a second entry the user has to reconcile.
 */
export interface ContactEntry {
  addr: string;
  name: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export async function saveContact(entry: ContactEntry): Promise<void> {
  const db = await getDb();
  await db.put('contacts', entry);
}

/** Insert or update by address, preserving the original `createdAt`. */
export async function upsertContact(
  addr: string,
  name: string,
  note?: string,
): Promise<ContactEntry> {
  const now = Date.now();
  const existing = await getContact(addr);
  const entry: ContactEntry = {
    addr,
    name,
    note: note?.trim() ? note.trim() : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveContact(entry);
  return entry;
}

export async function getContact(addr: string): Promise<ContactEntry | null> {
  const db = await getDb();
  return ((await db.get('contacts', addr)) as ContactEntry | undefined) ?? null;
}

/** Every contact, alphabetically by name (case-insensitive). */
export async function listContacts(): Promise<ContactEntry[]> {
  const db = await getDb();
  const all = (await db.getAll('contacts')) as ContactEntry[];
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function deleteContact(addr: string): Promise<void> {
  const db = await getDb();
  await db.delete('contacts', addr);
}

// ===== Passkey unlock =====

/**
 * The wallet sealed under a key derived from a passkey (WebAuthn PRF).
 *
 * Unlike the unlock session this record is meant to outlive the tab, which is
 * the whole point: it replaces typing the PIN on a device the user has already
 * proven they control. The sealing key is never stored — it only exists for the
 * moment after the authenticator returns the PRF output, so this record alone
 * decrypts to nothing. See wallet/passkey.ts.
 */
export interface PasskeyUnlockRecord {
  id: string;
  /** base64url credential id, used as the allowCredentials hint. */
  credentialId: string;
  /** Address of the sealed account, shown on the unlock screen. */
  addr: string;
  /** Account label, shown on the unlock screen. */
  name: string;
  /** Random per-credential PRF salt (base64). */
  prfSalt: string;
  iv: Uint8Array;
  ct: Uint8Array;
  createdAt: number;
}

export async function putPasskeyUnlock(rec: PasskeyUnlockRecord): Promise<void> {
  const db = await getDb();
  await db.put('passkey-unlock', rec);
}

export async function getPasskeyUnlock(
  id: string = 'default',
): Promise<PasskeyUnlockRecord | null> {
  const db = await getDb();
  return ((await db.get('passkey-unlock', id)) as PasskeyUnlockRecord | undefined) ?? null;
}

export async function deletePasskeyUnlock(id: string = 'default'): Promise<void> {
  const db = await getDb();
  await db.delete('passkey-unlock', id);
}

// ===== Maintenance =====

export async function wipeEverything(): Promise<void> {
  const db = await getDb();
  // Driven by OBJECT_STORES so a newly added store can never be forgotten here.
  for (const { name } of OBJECT_STORES) {
    if (db.objectStoreNames.contains(name)) await db.clear(name);
  }
}

/**
 * Close the connection and forget it, so the next storage call opens a fresh
 * one. Used by tests and by the unlock screen's retry, where the point is to
 * drop whatever half-open state produced the failure.
 */
export async function closeDb(): Promise<void> {
  const handles = [dbPromise, pendingOpen].filter((p): p is Promise<IDBPDatabase> => p !== null);
  forgetDb();
  for (const p of handles) {
    // A request that never lands must not make this hang, so close it if and
    // when it does; the bounded wait below covers the ordinary case.
    void p.then(
      (db) => db.close(),
      () => undefined,
    );
  }
  await Promise.all(handles.map((p) => settleWithin(p, DB_CLOSE_WAIT_MS)));
}
