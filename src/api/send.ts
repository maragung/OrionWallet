/**
 * Send / balance / history API layer.
 * Replaces the C++ HTTP routes /api/send, /api/balance, /api/history, /api/tx, /api/fee.
 */
import type {
  RpcClient,
  BalanceInfo,
  HistoryEntry,
  FeeSchedule,
  SubmitTxResult,
} from '../rpc/client';
import type { Wallet } from '../wallet/wallet';
import {
  signTransaction,
  buildTxJson,
  parseAmountRaw,
  recommendedOu,
  nowTs,
  type Transaction,
  type TransactionFields,
} from '../tx/builder';
import { isValidAddress } from '../crypto/address';
import { putTxCache, listTxCache } from '../wallet/storage';

export interface SendInputs {
  to: string;
  amount: string; // human-readable, e.g., "1.5"
  pin: string; // not used here (already verified by caller) but kept for API parity
  message?: string;
  ou?: string; // override fee
}

export interface SendResult {
  tx: Transaction;
  submitResult: SubmitTxResult;
}

/**
 * Send a standard transfer.
 * Mirrors C++ /api/send:
 *   1. Validate `to` address
 *   2. Parse amount → raw integer string
 *   3. Fetch sender nonce from RPC
 *   4. Build & sign Transaction with op_type="standard"
 *   5. Submit to RPC
 *   6. Cache tx locally
 */
export async function sendStandard(
  wallet: Wallet,
  rpc: RpcClient,
  inputs: SendInputs,
): Promise<SendResult> {
  if (!isValidAddress(inputs.to)) {
    throw new Error(`Invalid recipient address: ${inputs.to}`);
  }
  if (inputs.to === wallet.addr) {
    throw new Error('Cannot send to self via standard transfer (use encrypt/decrypt instead)');
  }
  const amountRaw = parseAmountRaw(inputs.amount);
  const raw = BigInt(amountRaw);
  if (raw <= 0n) throw new Error('Amount must be positive');

  // Fetch nonce
  const bi = await rpc.getBalance(wallet.addr);
  if (!bi.ok || !bi.result) {
    throw new Error(`Failed to fetch balance: ${bi.error ?? 'unknown'}`);
  }
  const nonce = bi.result.nonce + 1;

  // Determine fee
  const ou = inputs.ou ?? recommendedOu('standard', raw);

  // Build tx
  const fields: TransactionFields = {
    from: wallet.addr,
    to: inputs.to,
    amount: amountRaw,
    nonce,
    ou,
    timestamp: nowTs(),
    op_type: 'standard',
  };
  if (inputs.message) fields.message = inputs.message;

  const tx = signTransaction({
    secretKey: wallet.sk,
    publicKeyB64: wallet.pubB64,
    fields,
  });

  // Submit
  const submitResult = await rpc.submitTx(JSON.parse(buildTxJson(tx)));
  if (!submitResult.ok || !submitResult.result) {
    throw new Error(`Submit failed: ${submitResult.error ?? 'unknown'}`);
  }

  // Cache locally
  await putTxCache({
    key: `${wallet.addr}:${tx.hash}`,
    addr: wallet.addr,
    hash: tx.hash,
    tx,
    receivedAt: Date.now(),
  });

  return { tx, submitResult: submitResult.result };
}

/** Fetch balance info for an address.
 * Handles "sender not found" gracefully (new account with no on-chain history).
 */
export async function getBalance(rpc: RpcClient, addr: string): Promise<BalanceInfo> {
  const r = await rpc.getBalance(addr);
  if (!r.ok || !r.result) {
    // "sender not found" or similar means the account exists but has no on-chain state yet.
    // Return a zero-balance placeholder instead of throwing.
    if (r.error && (r.error.includes('sender not found') || r.error.includes('not found'))) {
      return {
        addr,
        balance: '0',
        balance_raw: '0',
        nonce: 0,
        encrypted_balance: '0',
        has_public_key: false,
      };
    }
    throw new Error(`getBalance failed: ${r.error ?? 'unknown'}`);
  }
  return r.result;
}

/** Fetch fee schedule. */
export async function getFeeSchedule(rpc: RpcClient): Promise<FeeSchedule> {
  const r = await rpc.getFee();
  if (!r.ok || !r.result) throw new Error(`getFee failed: ${r.error ?? 'unknown'}`);
  return r.result;
}

/** Fetch history (with local cache fallback). */
export async function getHistory(
  rpc: RpcClient,
  addr: string,
  opts: { limit?: number; useCache?: boolean } = {},
): Promise<HistoryEntry[]> {
  const r = await rpc.getHistory(addr, opts.limit ?? 50);
  if (r.ok && r.result) return r.result;
  // Fallback to local cache
  if (opts.useCache !== false) {
    const cached = await listTxCache(addr, opts.limit ?? 100);
    return cached.map((c) => c.tx as HistoryEntry);
  }
  throw new Error(`getHistory failed: ${r.error ?? 'unknown'}`);
}

/** Fetch a single transaction by hash. */
export async function getTx(rpc: RpcClient, hash: string): Promise<HistoryEntry> {
  const r = await rpc.getTx(hash);
  if (!r.ok || !r.result) throw new Error(`getTx failed: ${r.error ?? 'unknown'}`);
  return r.result;
}
