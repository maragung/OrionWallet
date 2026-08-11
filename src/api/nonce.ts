/**
 * Shared nonce-fetching for transaction builders.
 *
 * The node reports two counters on `octra_balance`:
 *   - `nonce`: the last CONFIRMED transaction's nonce
 *   - `pending_nonce`: the highest nonce already consumed by a PENDING tx in
 *     staging (when present)
 *
 * Using `nonce + 1` while a transaction is still pending reuses a nonce the
 * staging area already holds, so the node rejects the new transaction as
 * invalid/duplicate. The correct next nonce is therefore
 * `(pending_nonce ?? nonce) + 1` — prefer the pending counter when available.
 *
 * All transaction-building paths must go through this helper so a fix applies
 * everywhere, not just the one caller that hit the bug.
 */
import type { RpcClient } from '../rpc/client';

/** Fetch the next usable nonce for `addr`. New accounts (no on-chain state)
 *  get nonce 0 → next 1. */
export async function fetchNextNonce(rpc: RpcClient, addr: string): Promise<number> {
  const r = await rpc.getBalance(addr);
  if (!r.ok || !r.result) {
    // "sender not found" / "not found" = the account exists but has no on-chain
    // state yet. Treat it as a zero-nonce account instead of failing.
    if (r.error && (r.error.includes('sender not found') || r.error.includes('not found'))) {
      return 1;
    }
    throw new Error(`Failed to fetch nonce: ${r.error ?? 'unknown'}`);
  }
  const confirmed = r.result.nonce ?? 0;
  const pending = r.result.pending_nonce;
  return (pending !== undefined ? pending : confirmed) + 1;
}
