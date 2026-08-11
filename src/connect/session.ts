/**
 * Wallet-side session manager for the SDK connect flow.
 *
 * A session is minted when the user approves a connect request. It authorizes
 * SILENT reads (balance, accounts, network) for the origin until it expires.
 * Signing is never covered by a session — every sign opens an approval popup.
 *
 * Expiry model:
 *   - idle TTL: refreshed on each use (default 24 h). The connect popup closes
 *     right after approval (the MessagePort outlives it), so there is no
 *     background handler to keep the session warm — a dApp that simply sits
 *     open would otherwise trip a short idle TTL and force a re-approval on
 *     its next request. A long idle window matches real dApp usage.
 *   - absolute TTL: hard cap from creation (default 7 days)
 */
import {
  saveSdkSession,
  getSdkSession,
  findSdkSessionByOrigin,
  deleteSdkSession,
  type SdkSessionRecord,
} from '../wallet/storage';
import { randomBytes } from '../crypto/random';
import { hexEncode } from '../crypto/hex';

export const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const ABS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Permissions granted on a fresh connect.
 *
 * Read-only scopes only. Signing scopes are deliberately NOT included: they are
 * granted individually, the first time the dApp asks for that operation and the
 * user approves the prompt. See `grantPermission`.
 */
export const DEFAULT_PERMISSIONS = ['connect', 'viewAccounts', 'viewBalance', 'viewNetwork'];

/**
 * Signing scopes. Each is granted on first successful approval and then
 * persisted, so the permission check stops rejecting subsequent calls.
 *
 * Granting a scope does NOT skip future approval prompts — every signature still
 * requires explicit confirmation. The scope only records that the user has
 * agreed the dApp may ask at all.
 */
export const SIGNING_PERMISSIONS = [
  'signMessage',
  'signTypedData',
  'approveContract',
  'signContract',
] as const;

function newSid(): string {
  return hexEncode(randomBytes(16));
}

export async function createSession(input: {
  origin: string;
  address: string;
  accounts: string[];
  network: string;
  chainId: string;
  permissions?: string[];
}): Promise<SdkSessionRecord> {
  const now = Date.now();
  const rec: SdkSessionRecord = {
    sid: newSid(),
    origin: input.origin,
    address: input.address,
    accounts: input.accounts,
    network: input.network,
    chainId: input.chainId,
    permissions: input.permissions ?? DEFAULT_PERMISSIONS,
    createdAt: now,
    lastUsedAt: now,
    idleExpiresAt: now + IDLE_TTL_MS,
    absExpiresAt: now + ABS_TTL_MS,
  };
  await saveSdkSession(rec);
  return rec;
}

export function isExpired(rec: SdkSessionRecord, now = Date.now()): boolean {
  return rec.absExpiresAt <= now || rec.idleExpiresAt <= now;
}

/** Load a live session by id, or null if missing/expired (auto-deletes expired). */
export async function loadLiveSession(sid: string): Promise<SdkSessionRecord | null> {
  const rec = await getSdkSession(sid);
  if (!rec) return null;
  if (isExpired(rec)) {
    await deleteSdkSession(sid);
    return null;
  }
  return rec;
}

/** Find a live session for an origin (used by session-restore). */
export async function restoreSession(origin: string): Promise<SdkSessionRecord | null> {
  return findSdkSessionByOrigin(origin);
}

/** Refresh idle TTL on use; persist. Returns the updated record. */
export async function touchSession(rec: SdkSessionRecord): Promise<SdkSessionRecord> {
  const now = Date.now();
  rec.lastUsedAt = now;
  rec.idleExpiresAt = Math.min(now + IDLE_TTL_MS, rec.absExpiresAt);
  await saveSdkSession(rec);
  return rec;
}

export async function endSession(sid: string): Promise<void> {
  await deleteSdkSession(sid);
}

export function hasPermission(rec: SdkSessionRecord, perm: string): boolean {
  return rec.permissions.includes(perm);
}

/**
 * Persist a newly-granted permission scope onto the session.
 *
 * Called after the user approves an operation whose scope was not yet granted.
 * Idempotent — re-granting an existing scope is a no-op.
 */
export async function grantPermission(
  rec: SdkSessionRecord,
  perm: string,
): Promise<SdkSessionRecord> {
  const alreadyGranted = rec.permissions.includes(perm);
  const wasDenied = rec.deniedPermissions?.includes(perm) ?? false;
  if (alreadyGranted && !wasDenied) return rec;
  if (!alreadyGranted) rec.permissions = [...rec.permissions, perm];
  // Granting clears any prior revocation.
  if (wasDenied) {
    rec.deniedPermissions = rec.deniedPermissions!.filter((p) => p !== perm);
  }
  await saveSdkSession(rec);
  return rec;
}

/**
 * Explicitly revoke a scope.
 *
 * Signing scopes are granted lazily, so removing one from `permissions` is not
 * enough — it would look identical to "not yet requested" and be re-granted on
 * the next approval. Revocation is therefore recorded positively in
 * `deniedPermissions`, which the dispatcher refuses outright.
 */
export async function revokePermission(
  rec: SdkSessionRecord,
  perm: string,
): Promise<SdkSessionRecord> {
  rec.permissions = rec.permissions.filter((p) => p !== perm);
  const denied = new Set(rec.deniedPermissions ?? []);
  denied.add(perm);
  rec.deniedPermissions = [...denied];
  await saveSdkSession(rec);
  return rec;
}
