/**
 * OCS01 token discovery and balance reads.
 *
 * DISCOVERY STRATEGY — the balance probe IS the token detector.
 *
 * There is no token index on the node, and no way to derive holdings from
 * history: in an OCS01 `transfer` the transaction's `to` field is the token
 * CONTRACT, while the actual recipient sits inside the call arguments. A
 * recipient's `octra_account` therefore shows no trace of tokens they were
 * sent (verified on-chain). Scanning is the only sound approach.
 *
 * So rather than classifying contracts first and reading balances second, we
 * probe `balances:<me>` across every contract in one pass: a non-zero result
 * simultaneously proves "this is a token-shaped contract" and "I hold some".
 * Metadata is then fetched only for the handful of hits, which keeps the
 * expensive phase to a single key per contract.
 *
 * Cost, measured against live nodes: ~2.1k contracts on mainnet (~34s) and
 * ~6.5k on devnet (~146s) at 50 calls per batch with pacing. That is far too
 * slow to run automatically, so a full scan is always user-initiated and
 * cancellable; manual add-by-address stays instant.
 */
import type { RpcClient } from '../rpc/client';
import type { Wallet } from '../wallet/wallet';
import { buildTxJson } from '../tx/builder';
import { isValidAddress } from '../crypto/address';
import { signContractCall } from '../connect/typed-data';
import {
  OCS01_KEYS,
  MAX_U128,
  balanceKey,
  parseU128,
  parseDecimals,
  parseText,
  formatTokenAmount,
  type FormattedAmount,
} from '../tokens/ocs01';
import {
  getTokenRegistry,
  saveTokenRegistry,
  listTokenHoldings,
  saveTokenHolding,
  deleteTokenHolding,
  listCustomTokens,
  saveCustomToken,
  deleteCustomToken,
  tokenKey,
  type TokenHoldingEntry,
} from '../wallet/storage';

/** How long a cached contract list stays usable before we refetch it. */
const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Contracts probed per batched request. Mirrors the RPC client's cap. */
const PROBE_CHUNK = 50;

/** Pause between chunks. Sustained bursts draw HTTP 403 from the public nodes. */
const CHUNK_PAUSE_MS = 300;

export interface TokenHolding {
  contract: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  /** Raw base units. Always a bigint — never widened to Number. */
  raw: bigint;
  totalSupply: bigint | null;
  /** Preformatted for display; see `formatTokenAmount`. */
  amount: FormattedAmount;
  /** User added this by hand, so keep showing it at zero balance. */
  custom: boolean;
  updatedAt: number;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  found: number;
}

export class ScanCancelledError extends Error {
  constructor() {
    super('Token scan cancelled');
    this.name = 'ScanCancelledError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScanCancelledError();
}

/** Sleep that resolves early (and throws) when the scan is cancelled. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ScanCancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ScanCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rebuild a holding view-model from its persisted row. */
function toHolding(entry: TokenHoldingEntry, custom: boolean): TokenHolding {
  const raw = parseU128(entry.rawBalance) ?? 0n;
  return {
    contract: entry.contract,
    symbol: entry.symbol,
    name: entry.name,
    decimals: entry.decimals,
    raw,
    totalSupply: parseU128(entry.totalSupply),
    amount: formatTokenAmount(raw, entry.decimals),
    custom,
    updatedAt: entry.updatedAt,
  };
}

/** Load persisted holdings without touching the network. */
export async function loadCachedHoldings(rpcUrl: string, owner: string): Promise<TokenHolding[]> {
  const [rows, custom] = await Promise.all([
    listTokenHoldings(rpcUrl, owner),
    listCustomTokens(rpcUrl, owner),
  ]);
  const customSet = new Set(custom.map((c) => c.contract));
  return rows.map((r) => toHolding(r, customSet.has(r.contract))).sort(compareHoldings);
}

/** Non-zero balances first, then by symbol, then by address for stability. */
function compareHoldings(a: TokenHolding, b: TokenHolding): number {
  if (a.raw > 0n !== b.raw > 0n) return a.raw > 0n ? -1 : 1;
  const sa = a.symbol ?? '';
  const sb = b.symbol ?? '';
  if (sa !== sb) return sa.localeCompare(sb);
  return a.contract.localeCompare(b.contract);
}

/** Fetch the contract list, reusing the cached copy while it is fresh. */
export async function getContractList(
  rpc: RpcClient,
  opts: { force?: boolean } = {},
): Promise<string[]> {
  if (!opts.force) {
    const cached = await getTokenRegistry(rpc.url);
    if (cached && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS) return cached.addresses;
  }

  const r = await rpc.listContracts();
  if (!r.ok || !r.result) {
    // Fall back to a stale list rather than failing outright — an outdated
    // list still finds every token the user already holds.
    const cached = await getTokenRegistry(rpc.url);
    if (cached) return cached.addresses;
    throw new Error(`listContracts failed: ${r.error ?? 'unknown'}`);
  }

  const addresses = r.result.map((c) => c.address).filter((a) => typeof a === 'string' && a !== '');
  await saveTokenRegistry({ id: rpc.url, addresses, fetchedAt: Date.now() });
  return addresses;
}

/**
 * Read the OCS01 metadata + this owner's balance for one contract.
 *
 * `rawBalance` is null when the balance read FAILED, which is deliberately
 * distinct from a successful read of zero. Callers must not persist a failed
 * read as a zero balance — doing so would erase a real holding whenever the
 * network hiccups.
 */
async function readTokenAt(
  rpc: RpcClient,
  contract: string,
  owner: string,
): Promise<{
  contract: string;
  rawBalance: bigint | null;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: string | null;
} | null> {
  const keys = [
    OCS01_KEYS.symbol,
    OCS01_KEYS.name,
    OCS01_KEYS.decimals,
    OCS01_KEYS.totalSupply,
    balanceKey(owner),
  ];
  const results = await rpc.rpcBatch<{ value?: unknown }>(
    keys.map((k) => ({ method: 'octra_contractStorage', params: [contract, k] })),
  );

  const value = (i: number): unknown => (results[i]?.ok ? results[i].result?.value : null);

  const symbol = parseText(value(0));
  const balanceOk = results[4]?.ok === true;
  const rawBalance = balanceOk ? (parseU128(value(4)) ?? 0n) : null;
  /** The balance key actually exists (as opposed to reading back as absent). */
  const hasBalanceEntry = balanceOk && parseU128(value(4)) !== null;

  // Require SOME evidence of a token: an identifying symbol, or a real balance
  // entry for this owner. A contract that simply answers "null" to every key is
  // not a token, and a successful read of an absent key is not evidence.
  if (symbol === null && !hasBalanceEntry) return null;

  return {
    contract,
    rawBalance,
    symbol,
    name: parseText(value(1)),
    decimals: parseDecimals(value(2)),
    totalSupply: parseU128(value(3))?.toString() ?? null,
  };
}

/**
 * Add a token by contract address.
 *
 * Kept in `token-custom` so it survives a zero balance — a user who adds a
 * token before receiving any should still see it.
 */
export async function addTokenByAddress(
  rpc: RpcClient,
  owner: string,
  contract: string,
): Promise<TokenHolding> {
  const data = await readTokenAt(rpc, contract, owner);
  if (data === null) {
    throw new Error('No OCS01 token found at that address (no symbol and no balance entry).');
  }

  const key = tokenKey(rpc.url, owner, contract);
  const entry: TokenHoldingEntry = {
    key,
    rpcUrl: rpc.url,
    owner,
    contract,
    // A first-time add with an unreadable balance starts at zero; there is no
    // prior value to protect, and the next refresh will correct it.
    rawBalance: (data.rawBalance ?? 0n).toString(),
    symbol: data.symbol,
    name: data.name,
    decimals: data.decimals,
    totalSupply: data.totalSupply,
    updatedAt: Date.now(),
  };
  await saveTokenHolding(entry);
  await saveCustomToken({ key, rpcUrl: rpc.url, owner, contract, addedAt: Date.now() });
  return toHolding(entry, true);
}

/** Forget a token: drops both the holding row and any manual entry. */
export async function removeToken(rpcUrl: string, owner: string, contract: string): Promise<void> {
  await deleteTokenHolding(rpcUrl, owner, contract);
  await deleteCustomToken(rpcUrl, owner, contract);
}

/**
 * Re-read balances for tokens already known to this wallet.
 *
 * Cheap (one batch for a typical wallet), so this is safe to run on panel open,
 * unlike a full scan.
 */
export async function refreshHoldings(
  rpc: RpcClient,
  owner: string,
  signal?: AbortSignal,
): Promise<TokenHolding[]> {
  const existing = await loadCachedHoldings(rpc.url, owner);
  if (existing.length === 0) return [];

  const results = await rpc.rpcBatch<{ value?: unknown }>(
    existing.map((h) => ({
      method: 'octra_contractStorage',
      params: [h.contract, balanceKey(owner)],
    })),
  );
  throwIfAborted(signal);

  const out: TokenHolding[] = [];
  for (let i = 0; i < existing.length; i++) {
    const h = existing[i];
    const r = results[i];
    // A failed read must not be mistaken for a zero balance; keep the last
    // known value instead of destroying it.
    if (!r?.ok) {
      out.push(h);
      continue;
    }
    const raw = parseU128(r.result?.value) ?? 0n;
    const entry: TokenHoldingEntry = {
      key: tokenKey(rpc.url, owner, h.contract),
      rpcUrl: rpc.url,
      owner,
      contract: h.contract,
      rawBalance: raw.toString(),
      symbol: h.symbol,
      name: h.name,
      decimals: h.decimals,
      totalSupply: h.totalSupply?.toString() ?? null,
      updatedAt: Date.now(),
    };
    await saveTokenHolding(entry);
    out.push(toHolding(entry, h.custom));
  }
  return out.sort(compareHoldings);
}

/**
 * Full scan: probe `balances:<owner>` across every deployed contract.
 *
 * Always user-initiated. Reports progress per chunk and honours `signal`
 * promptly so the UI can cancel mid-scan.
 */
export async function scanForTokens(
  rpc: RpcClient,
  owner: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ScanProgress) => void;
    force?: boolean;
  } = {},
): Promise<TokenHolding[]> {
  const { signal, onProgress } = opts;
  throwIfAborted(signal);

  const contracts = await getContractList(rpc, { force: opts.force });
  throwIfAborted(signal);

  const hits: Array<{ contract: string; raw: bigint }> = [];
  let scanned = 0;
  onProgress?.({ scanned: 0, total: contracts.length, found: 0 });

  for (let i = 0; i < contracts.length; i += PROBE_CHUNK) {
    throwIfAborted(signal);
    const chunk = contracts.slice(i, i + PROBE_CHUNK);

    const results = await rpc.rpcBatch<{ value?: unknown }>(
      chunk.map((addr) => ({
        method: 'octra_contractStorage',
        params: [addr, balanceKey(owner)],
      })),
    );

    for (let j = 0; j < chunk.length; j++) {
      const r = results[j];
      if (!r?.ok) continue;
      const raw = parseU128(r.result?.value);
      if (raw !== null && raw > 0n) hits.push({ contract: chunk[j], raw });
    }

    scanned += chunk.length;
    onProgress?.({ scanned, total: contracts.length, found: hits.length });

    if (i + PROBE_CHUNK < contracts.length) await pause(CHUNK_PAUSE_MS, signal);
  }

  // Metadata only for hits — a few calls, not thousands.
  for (const hit of hits) {
    throwIfAborted(signal);
    const data = await readTokenAt(rpc, hit.contract, owner);
    if (data === null) continue;
    await saveTokenHolding({
      key: tokenKey(rpc.url, owner, hit.contract),
      rpcUrl: rpc.url,
      owner,
      contract: hit.contract,
      // Prefer the probe's balance when the metadata re-read failed: the probe
      // already proved this balance is non-zero, so falling back to 0 here
      // would erase a confirmed holding.
      rawBalance: (data.rawBalance ?? hit.raw).toString(),
      symbol: data.symbol,
      name: data.name,
      decimals: data.decimals,
      totalSupply: data.totalSupply,
      updatedAt: Date.now(),
    });
  }

  return loadCachedHoldings(rpc.url, owner);
}

// ===== Transfer =====

/** OCS01 method name for a direct transfer. */
export const TRANSFER_METHOD = 'transfer';

export interface TransferTokenInput {
  contract: string;
  to: string;
  /** Amount in raw base units. Must already be scaled by the token's decimals. */
  raw: bigint;
  /** Fee override in raw OCT units. Defaults to the live schedule's fast tier. */
  ou?: string;
}

export interface TransferTokenResult {
  hash: string;
  /** The exact `message` payload that was signed, for display/audit. */
  argsJson: string;
  ou: string;
  nonce: number;
}

/**
 * Transfer an OCS01 token.
 *
 * Encoded as an `op_type: "call"` transaction, matching the shape observed
 * on-chain: the tx is addressed TO THE TOKEN CONTRACT, `encrypted_data` holds
 * the bare method name, and `message` holds the JSON argument array. The OCT
 * `amount` is zero — the token moves in contract state, not as native value.
 *
 * The amount is passed as a bigint all the way into the signer, which encodes
 * it as a bare JSON integer. Because the Ed25519 signature covers the canonical
 * JSON, an amount mangled here cannot be repaired afterwards.
 */
export async function transferToken(
  rpc: RpcClient,
  wallet: Wallet,
  input: TransferTokenInput,
): Promise<TransferTokenResult> {
  if (!isValidAddress(input.contract)) {
    throw new Error('Invalid token contract address');
  }
  if (!isValidAddress(input.to)) {
    throw new Error('Invalid recipient address');
  }
  if (input.to === wallet.addr) {
    // The reference contract rejects this outright ("self transfer disabled"),
    // so fail before spending a fee on a transaction that cannot succeed.
    throw new Error('Cannot transfer to your own address');
  }
  if (input.raw <= 0n) {
    throw new Error('Amount must be greater than zero');
  }
  if (input.raw > MAX_U128) {
    throw new Error('Amount exceeds the u128 maximum');
  }

  // Verify the on-chain balance covers this transfer before paying a fee.
  const balRes = await rpc.rpcCall<{ value?: unknown }>('octra_contractStorage', [
    input.contract,
    balanceKey(wallet.addr),
  ]);
  if (balRes.ok) {
    const held = parseU128(balRes.result?.value) ?? 0n;
    if (held < input.raw) {
      throw new Error('Insufficient token balance');
    }
  }

  const nonceRes = await rpc.getBalance(wallet.addr);
  if (!nonceRes.ok || !nonceRes.result) {
    throw new Error(`Failed to fetch nonce: ${nonceRes.error ?? 'unknown'}`);
  }
  const nonce = nonceRes.result.nonce + 1;

  // Prefer the node's live fee schedule over a hardcoded constant: observed
  // `call` fees on devnet ranged from 2000 to 150000.
  let ou = input.ou;
  if (!ou) {
    const fee = await rpc.getFee();
    ou = fee.ok && fee.result?.fast ? String(fee.result.fast) : undefined;
  }

  const signed = signContractCall(wallet, {
    program: input.contract,
    method: TRANSFER_METHOD,
    // bigint reaches the encoder intact; it is emitted as bare JSON digits.
    args: [input.to, input.raw],
    nonce,
    opType: 'call',
    ou,
  });

  const submit = await rpc.submitTx(JSON.parse(buildTxJson(signed.tx)));
  if (!submit.ok || !submit.result) {
    throw new Error(`Submit failed: ${submit.error ?? 'unknown'}`);
  }

  return {
    hash: submit.result.hash ?? signed.tx.hash ?? '',
    argsJson: signed.tx.message ?? '',
    ou: signed.tx.ou,
    nonce,
  };
}
