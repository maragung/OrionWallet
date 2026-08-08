/**
 * Wallet API layer.
 * Replaces the C++ HTTP routes (/api/wallet/*, /api/send, /api/balance, etc.).
 *
 * All functions are async and operate on the in-memory wallet + IndexedDB.
 * The React UI calls these instead of `fetch('/api/...')`.
 */
import type { Wallet } from '../wallet/wallet';
import {
  createWallet as _createWallet,
  importWalletFromMnemonic as _importMnemonic,
  importWalletFromSeed as _importSeed,
  importWalletFromSecretKey as _importSk,
  deriveHdAccount as _deriveHd,
  saveWalletEncrypted,
  loadWalletEncrypted,
  wipeWallet,
} from '../wallet/wallet';
import {
  saveWalletEntry,
  loadWalletEntry,
  listWalletEntries,
  deleteWalletEntry,
  loadManifest,
  saveManifest,
  addAccountToManifest,
  removeAccountFromManifest,
  setActiveAccount,
  type StoredWalletEntry,
  type ManifestEntry,
  type Manifest,
} from '../wallet/storage';
import { assertValidPin } from '../wallet/pin';
import { withTimeout } from '../utils/withTimeout';

/**
 * Budget for reading the encrypted blob out of IndexedDB. Generous enough for a
 * cold database, short enough that a blocked upgrade surfaces quickly.
 */
export const WALLET_READ_TIMEOUT_MS = 10_000;
import { isValidAddress } from '../crypto/address';
import { base64Decode } from '../crypto/base64';

export interface WalletState {
  wallet: Wallet | null;
  isLoaded: boolean;
  isLocked: boolean;
  activeAddr: string | null;
}

/** Create a brand new wallet, encrypt, and persist to IndexedDB. */
export async function createNewWallet(
  name: string,
  pin: string,
): Promise<{ wallet: Wallet; mnemonic: string }> {
  assertValidPin(pin);
  const wallet = await _createWallet(name);
  const blob = await saveWalletEncrypted(wallet, pin);
  const entry: StoredWalletEntry = {
    id: 'default',
    blob,
    addrHint: wallet.addr.slice(0, 8) + '...',
    name: wallet.name,
    createdAt: wallet.createdAt,
  };
  await saveWalletEntry(entry);
  const manifestEntry: ManifestEntry = {
    addr: wallet.addr,
    name: wallet.name,
    index: wallet.index,
    pubB64: wallet.pubB64,
    createdAt: wallet.createdAt,
  };
  await addAccountToManifest(manifestEntry);
  return { wallet, mnemonic: wallet.mnemonic };
}

/** Import a wallet from a mnemonic phrase. */
export async function importMnemonic(mnemonic: string, name: string, pin: string): Promise<Wallet> {
  assertValidPin(pin);
  const wallet = await _importMnemonic(mnemonic, name, 0, { strictChecksum: false });
  const blob = await saveWalletEncrypted(wallet, pin);
  const entry: StoredWalletEntry = {
    id: 'default',
    blob,
    addrHint: wallet.addr.slice(0, 8) + '...',
    name: wallet.name,
    createdAt: wallet.createdAt,
  };
  await saveWalletEntry(entry);
  const manifestEntry: ManifestEntry = {
    addr: wallet.addr,
    name: wallet.name,
    index: wallet.index,
    pubB64: wallet.pubB64,
    createdAt: wallet.createdAt,
  };
  await addAccountToManifest(manifestEntry);
  return wallet;
}

/** Import a wallet from a 32-byte seed (hex or base64). */
export async function importSeed(seed: Uint8Array, name: string, pin: string): Promise<Wallet> {
  assertValidPin(pin);
  const wallet = _importSeed(seed);
  wallet.name = name;
  const blob = await saveWalletEncrypted(wallet, pin);
  const entry: StoredWalletEntry = {
    id: 'default',
    blob,
    addrHint: wallet.addr.slice(0, 8) + '...',
    name: wallet.name,
    createdAt: wallet.createdAt,
  };
  await saveWalletEntry(entry);
  await addAccountToManifest({
    addr: wallet.addr,
    name: wallet.name,
    index: wallet.index,
    pubB64: wallet.pubB64,
    createdAt: wallet.createdAt,
  });
  return wallet;
}

/** Unlock (decrypt) the persisted wallet with PIN. */
export async function unlockWallet(
  pin: string,
  id: string = 'default',
  readTimeoutMs: number = WALLET_READ_TIMEOUT_MS,
): Promise<Wallet> {
  // Only the storage read is bounded: it is the step that can wedge forever
  // (e.g. an IndexedDB upgrade blocked by another tab). Decryption is CPU-bound
  // — PBKDF2 at 600k iterations takes seconds on the pure-JS fallback path used
  // when crypto.subtle is unavailable — so it must never be cut short.
  const entry = await withTimeout(
    loadWalletEntry(id),
    readTimeoutMs,
    'Reading the stored wallet timed out. If the wallet is open in another tab, close it and try again.',
  );
  if (!entry) throw new Error(`No stored wallet with id '${id}'`);
  const wallet = await loadWalletEncrypted(entry.blob, pin);
  return wallet;
}

/** Lock the wallet (wipe in-memory secrets). */
export function lockWallet(wallet: Wallet): void {
  wipeWallet(wallet);
}

/** List all stored wallet entries (without decrypting). */
export async function listStoredWallets(): Promise<StoredWalletEntry[]> {
  return listWalletEntries();
}

/** Delete a stored wallet. */
export async function removeStoredWallet(id: string): Promise<void> {
  await deleteWalletEntry(id);
  // If we have a manifest entry for this wallet, remove that too
  // (best-effort — manifest is keyed by addr, not wallet id)
}

/** Change PIN: re-encrypt the wallet blob with a new PIN. */
export async function changePin(wallet: Wallet, oldPin: string, newPin: string): Promise<void> {
  assertValidPin(newPin);
  // Verify old PIN by attempting decryption
  const entry = await loadWalletEntry('default');
  if (!entry) throw new Error('No stored wallet to re-encrypt');
  await loadWalletEncrypted(entry.blob, oldPin); // throws on wrong PIN
  // Re-encrypt with new PIN
  const newBlob = await saveWalletEncrypted(wallet, newPin);
  const newEntry: StoredWalletEntry = {
    ...entry,
    blob: newBlob,
  };
  await saveWalletEntry(newEntry);
}

/** Derive a new HD account from the current wallet's master seed. */
export async function deriveNewHdAccount(
  parent: Wallet,
  accountIndex: number,
  name: string,
  pin: string,
): Promise<Wallet> {
  if (parent.hdMaster.length !== 64) {
    throw new Error('Current wallet has no HD master seed (imported via private key)');
  }
  assertValidPin(pin);
  const newWallet = _deriveHd(parent, accountIndex, name);
  // Persist: we currently overwrite the default wallet entry.
  // For multi-account storage, the manifest + a separate wallet entry per account
  // would be needed. For now, we just add to manifest.
  const blob = await saveWalletEncrypted(newWallet, pin);
  await saveWalletEntry({
    id: `acct-${newWallet.addr.slice(0, 12)}`,
    blob,
    addrHint: newWallet.addr.slice(0, 8) + '...',
    name: newWallet.name,
    createdAt: newWallet.createdAt,
  });
  await addAccountToManifest({
    addr: newWallet.addr,
    name: newWallet.name,
    index: newWallet.index,
    pubB64: newWallet.pubB64,
    createdAt: newWallet.createdAt,
  });
  return newWallet;
}

/** List accounts in the manifest. */
export async function listAccounts(): Promise<ManifestEntry[]> {
  const m = await loadManifest();
  return m.accounts;
}

/** Switch active account. */
export async function switchAccount(addr: string): Promise<Manifest> {
  if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
  return setActiveAccount(addr);
}

/**
 * Unlock a specific account and return its in-memory wallet.
 *
 * Switching the manifest's `activeAddr` alone is not enough: the wallet held in
 * memory carries the signing keys of whichever account was unlocked, so the UI
 * would keep showing the old account. This resolves the real wallet for `addr`
 * so the caller can push it into the store.
 *
 * Resolution order:
 *   1. The per-account blob written by `deriveNewHdAccount` (`acct-<addr12>`).
 *   2. The `default` blob — either it already IS the target account, or it holds
 *      the BIP39 master seed we can deterministically derive the target from.
 *
 * The manifest's active account is only updated once a wallet is resolved, so a
 * wrong PIN leaves the previous selection untouched.
 */
export async function unlockAccount(addr: string, pin: string): Promise<Wallet> {
  if (!isValidAddress(addr)) throw new Error(`Invalid address: ${addr}`);
  assertValidPin(pin);

  const manifest = await loadManifest();
  const entry = manifest.accounts.find((a) => a.addr === addr);
  if (!entry) throw new Error(`Account ${addr} is not in the manifest`);

  // 1. Per-account blob (present for accounts created via "Derive New").
  const perAccount = await loadWalletEntry(`acct-${addr.slice(0, 12)}`);
  if (perAccount) {
    const w = await loadWalletEncrypted(perAccount.blob, pin); // throws on wrong PIN
    if (w.addr === addr) {
      await setActiveAccount(addr);
      return w;
    }
  }

  // 2. Default blob — the account itself, or the HD root to derive from.
  const root = await loadWalletEntry('default');
  if (!root) throw new Error('No stored wallet');
  const rootWallet = await loadWalletEncrypted(root.blob, pin); // throws on wrong PIN
  if (rootWallet.addr === addr) {
    await setActiveAccount(addr);
    return rootWallet;
  }

  if (rootWallet.hdMaster.length !== 64) {
    throw new Error(
      'This account cannot be unlocked: the stored wallet has no HD master seed ' +
        '(it was imported via private key).',
    );
  }

  const derived = _deriveHd(rootWallet, entry.index, entry.name);
  if (derived.addr !== addr) {
    throw new Error(
      `Derivation mismatch for account index ${entry.index}: expected ${addr}, got ${derived.addr}`,
    );
  }
  await setActiveAccount(addr);
  return derived;
}

/** Remove an account from the manifest and delete its encrypted wallet blob. */
export async function removeAccount(addr: string): Promise<Manifest> {
  const manifest = await loadManifest();
  const entry = manifest.accounts.find((a) => a.addr === addr);

  // Delete the per-account encrypted blob (best-effort)
  try {
    await deleteWalletEntry(`acct-${addr.slice(0, 12)}`);
  } catch {
    // May not exist — that's fine
  }

  // If this is the default (index 0) account, also delete the default blob
  // since it holds the HD master seed that derives all accounts.
  if (entry && entry.index === 0) {
    try {
      await deleteWalletEntry('default');
    } catch {
      // May not exist — that's fine
    }
  }

  return removeAccountFromManifest(addr);
}

/** Get the active account address. */
export async function getActiveAddress(): Promise<string | null> {
  const m = await loadManifest();
  return m.activeAddr;
}

/** Export the private key (64-byte secret key) as base64. Requires PIN. */
export async function exportPrivateKey(wallet: Wallet, pin: string): Promise<string> {
  // Verify PIN by re-decrypting the stored blob
  const entry = await loadWalletEntry('default');
  if (!entry) throw new Error('No stored wallet');
  await loadWalletEncrypted(entry.blob, pin); // throws on wrong PIN
  return wallet.privB64;
}

/** Decode a base64-encoded private key (for import). */
export function decodePrivB64(privB64: string): Uint8Array {
  return base64Decode(privB64);
}

export { saveManifest, loadManifest };
