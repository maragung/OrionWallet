/**
 * Watch-only accounts.
 *
 * A watch-only account is an address the wallet tracks but cannot spend from:
 * there is no keystore blob, no PIN, and no keys in memory. Balance, history and
 * tokens work exactly as usual; anything that needs a signature is refused with
 * a specific error rather than a confusing crypto-layer one.
 *
 * The account lives only in the manifest (`watchOnly: true`, `index: -1`), so
 * removing it can never destroy key material — there is none to destroy.
 */
import { isValidAddress } from '../crypto/address';
import { base64Decode } from '../crypto/base64';
import type { ManifestEntry } from './storage';
import type { Wallet } from './wallet';

/** Manifest index used for watch-only entries — they are not HD-derived. */
export const WATCH_ONLY_INDEX = -1;

/** Thrown when an operation needs keys the active account does not have. */
export class WatchOnlyError extends Error {
  constructor(action: string) {
    super(
      `This is a watch-only account, so it cannot ${action}. ` +
        'Switch to an account with keys, or import the recovery phrase for this address.',
    );
    this.name = 'WatchOnlyError';
  }
}

export function isWatchOnly(wallet: Pick<Wallet, 'watchOnly'> | null | undefined): boolean {
  return !!wallet?.watchOnly;
}

/**
 * Refuse an operation that requires a signature.
 * `action` completes the sentence "…cannot <action>", e.g. "send transactions".
 */
export function assertCanSign(
  wallet: Pick<Wallet, 'watchOnly' | 'sk'> | null | undefined,
  action: string = 'sign',
): void {
  if (!wallet) throw new Error('No wallet is open');
  // Both conditions mean the same thing; checking the keys too means a wallet
  // that lost its keys some other way cannot slip past this guard.
  if (wallet.watchOnly || wallet.sk.length !== 64) throw new WatchOnlyError(action);
}

/**
 * Build the in-memory wallet for a watch-only manifest entry. Keys are empty —
 * deliberately, so every signing path fails closed.
 */
export function makeWatchOnlyWallet(entry: ManifestEntry): Wallet {
  if (!isValidAddress(entry.addr)) throw new Error(`Invalid address: ${entry.addr}`);
  let pk = new Uint8Array(0);
  if (entry.pubB64) {
    try {
      pk = new Uint8Array(base64Decode(entry.pubB64));
    } catch {
      // A watch-only account does not need the public key: it is only used for
      // local signature verification, which never happens without keys.
      pk = new Uint8Array(0);
    }
  }
  return {
    addr: entry.addr,
    sk: new Uint8Array(0),
    pk,
    pubB64: entry.pubB64 ?? '',
    privB64: '',
    mnemonic: '',
    hdMaster: new Uint8Array(0),
    name: entry.name || 'Watch-only',
    index: entry.index ?? WATCH_ONLY_INDEX,
    hdVersion: 2,
    createdAt: entry.createdAt ?? 0,
    watchOnly: true,
  };
}
