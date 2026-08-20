/**
 * OCS01 token discovery and balance reads.
 *
 * DISCOVERY STRATEGY — the balance probe IS the token detector.
 *
 * There is no token index on the node, and no way to derive holdings from
 * history: in an OCS01 `transfer` the transaction's `to` field is the token
 * CONTRACT, while the actual recipient sits inside the call arguments. A
 * recipient's `octra_account` therefore shows no trace of tokens they were
 * sent (verified on-chain). Probing `balances:<me>` is the only sound approach.
 *
 * So rather than classifying contracts first and reading balances second, we
 * probe `balances:<me>` across every contract: a non-zero result simultaneously
 * proves "this is a token-shaped contract" and "I hold some". Metadata is then
 * fetched only for the hits, which keeps the wide phase at one key per
 * contract.
 *
 * TWO PHASES, so the list is not empty while the wide sweep runs:
 *   1. Contracts this address DEPLOYED, identified for free from the `owner`
 *      field of `octra_listContracts`. Few enough to read metadata for
 *      outright, which also surfaces tokens the address minted but holds none
 *      of — ownership, not just balance.
 *   2. Every remaining contract, one probe key each.
 * Phase 1 alone is not enough: measured on devnet, 4 of one address's 13
 * holdings were RECEIVED rather than deployed, so phase 2 always follows.
 *
 * PACING. The public nodes answer HTTP 429 above a sustained request rate, and
 * a throttled batch loses all 50 of its probes at once — silently, unless the
 * caller notices. Measured over full devnet sweeps (6778 contracts, 136 batches
 * of 50, same address each time):
 *   - no pause (~8.9 req/s):            30 batches throttled, 11 of 13 found
 *   - two batches in flight (~12.8/s):  89 batches throttled,  9 of 13 found
 *   - 150ms between batches (~3.7/s):    0 batches throttled, 13 of 13 found
 * Hence CHUNK_PAUSE_MS, plus retry-with-backoff for throttling that survives
 * it, plus an explicit `unreadable` count so a sweep that lost chunks is never
 * mistaken for proof that nothing else is held.
 *
 * COST at that pacing: ~37s on devnet, ~11s on mainnet (2081 contracts). Hits
 * stream out as they are found, and completion is recorded per (endpoint,
 * address), so discovery runs at most once per DISCOVERY_TTL_MS rather than on
 * every visit. Balances of tokens already known refresh in a single batch.
 */
import type { RpcClient, RpcResult } from '../rpc/client';
import type { Wallet } from '../wallet/wallet';
import { buildTxJson } from '../tx/builder';
import { isValidAddress } from '../crypto/address';
import { signContractCall } from '../connect/typed-data';
import { fetchNextNonce } from './nonce';
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
  getTokenScan,
  saveTokenScan,
  tokenKey,
  scanKey,
  type TokenHoldingEntry,
  type TokenRegistryEntry,
} from '../wallet/storage';

/** How long a cached contract list stays usable before we refetch it. */
const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Contracts probed per batched request. Mirrors the RPC client's cap, so one
 *  chunk is exactly one HTTP request. */
const PROBE_CHUNK = 50;

/**
 * Pause between batches. See the pacing note above: this is the difference
 * between finding every token and silently losing a third of them.
 */
const CHUNK_PAUSE_MS = 150;

/** Backoff for a throttled batch: 0.5s, 1s, 2s, 4s. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 4_000;
const MAX_CHUNK_RETRIES = 4;

/**
 * Give up on a sweep after this many batches in a row fail outright.
 *
 * Each batch waits out the client's 15s timeout, so an endpoint that has gone
 * away would otherwise keep an automatic sweep grinding for half an hour. The
 * calls never attempted are reported as unreadable, which is exactly what they
 * are — and stops the sweep claiming it proved anything.
 */
const MAX_CONSECUTIVE_CHUNK_FAILURES = 3;

/**
 * How long a completed sweep suppresses the next one.
 *
 * Only a sweep can find a token that was RECEIVED (see the strategy note), so
 * this is the staleness a user may see for an incoming token they were not
 * expecting. Balances of known tokens are re-read on every visit regardless,
 * and the manual rescan ignores this entirely.
 */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000; // 10min

/**
 * Only throttling is retried.
 *
 * HTTP 429 is the one failure the node uses to mean "ask again shortly", and
 * it is the one that would otherwise turn into missing tokens. A 502 or a
 * timeout is reported as-is: callers already keep the previous balance and
 * count the read as unreadable, so retrying just delays an honest answer.
 */
const RETRYABLE_STATUS = new Set([429]);

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
  /** This address deployed the contract, so keep showing it at zero balance. */
  deployed: boolean;
  updatedAt: number;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  found: number;
}

export interface DiscoveryResult {
  holdings: TokenHolding[];
  /**
   * Contracts whose balance could not be read this sweep.
   *
   * Non-zero means "there may be more" — the caller should say so rather than
   * present the list as complete.
   */
  unreadable: number;
  contractCount: number;
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
    deployed: entry.deployed === true,
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
export function compareHoldings(a: TokenHolding, b: TokenHolding): number {
  if (a.raw > 0n !== b.raw > 0n) return a.raw > 0n ? -1 : 1;
  const sa = a.symbol ?? '';
  const sb = b.symbol ?? '';
  if (sa !== sb) return sa.localeCompare(sb);
  return a.contract.localeCompare(b.contract);
}

export interface ContractRegistry {
  addresses: string[];
  /**
   * Deployer of `addresses[i]`, same order.
   *
   * Empty when the cached list predates this field: the deployer fast path is
   * an optimisation, so losing it degrades speed rather than correctness.
   */
  owners: string[];
}

/** Fetch the contract list with deployers, reusing the cache while it is fresh. */
export async function getContractRegistry(
  rpc: RpcClient,
  opts: { force?: boolean } = {},
): Promise<ContractRegistry> {
  const fromCache = (c: TokenRegistryEntry): ContractRegistry => ({
    addresses: c.addresses,
    owners: c.owners?.length === c.addresses.length ? c.owners : [],
  });

  if (!opts.force) {
    const cached = await getTokenRegistry(rpc.url);
    if (cached && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS) return fromCache(cached);
  }

  const r = await rpc.listContracts();
  if (!r.ok || !r.result) {
    // Fall back to a stale list rather than failing outright — an outdated
    // list still finds every token the user already holds.
    const cached = await getTokenRegistry(rpc.url);
    if (cached) return fromCache(cached);
    throw new Error(`listContracts failed: ${r.error ?? 'unknown'}`);
  }

  const entries = r.result.filter((c) => typeof c.address === 'string' && c.address !== '');
  const addresses = entries.map((c) => c.address);
  const owners = entries.map((c) => (typeof c.owner === 'string' ? c.owner : ''));
  await saveTokenRegistry({ id: rpc.url, addresses, owners, fetchedAt: Date.now() });
  return { addresses, owners };
}

/** Addresses only, for callers that do not care who deployed what. */
export async function getContractList(
  rpc: RpcClient,
  opts: { force?: boolean } = {},
): Promise<string[]> {
  return (await getContractRegistry(rpc, opts)).addresses;
}

/** True when a whole batch failed for a reason that may pass on its own. */
function isThrottled(results: ReadonlyArray<RpcResult<unknown>>): boolean {
  return (
    results.length > 0 && results.every((r) => !r.ok) && RETRYABLE_STATUS.has(results[0].status)
  );
}

/**
 * One batch, retried while the node throttles it.
 *
 * Retrying matters more than it looks: `rpcBatch` reports a throttled batch as
 * 50 individual failures, and a caller that treats a failure as "no balance"
 * turns rate limiting into missing tokens.
 */
async function batchWithRetry<T>(
  rpc: RpcClient,
  chunk: ReadonlyArray<{ method: string; params?: unknown[] }>,
  signal?: AbortSignal,
): Promise<Array<RpcResult<T>>> {
  let results = await rpc.rpcBatch<T>(chunk);
  for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES && isThrottled(results); attempt++) {
    await pause(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS), signal);
    results = await rpc.rpcBatch<T>(chunk);
  }
  return results;
}

/**
 * Run many storage reads at the node's sustainable rate.
 *
 * Chunks at PROBE_CHUNK (one request each), pauses between them, and retries a
 * throttled chunk. Results stay in request order, one per call.
 */
async function pacedBatch<T>(
  rpc: RpcClient,
  calls: ReadonlyArray<{ method: string; params?: unknown[] }>,
  opts: { signal?: AbortSignal; onChunk?: (done: number, total: number) => void } = {},
): Promise<Array<RpcResult<T>>> {
  const out: Array<RpcResult<T>> = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < calls.length; i += PROBE_CHUNK) {
    throwIfAborted(opts.signal);
    // Pause before every chunk but the first: the caller may be mid-sweep, and
    // pacing on entry means a cancellation lands here rather than after another
    // request has already gone out.
    if (i > 0) await pause(CHUNK_PAUSE_MS, opts.signal);

    const results = await batchWithRetry<T>(rpc, calls.slice(i, i + PROBE_CHUNK), opts.signal);
    out.push(...results);
    opts.onChunk?.(out.length, calls.length);

    consecutiveFailures = results.every((r) => !r.ok) ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= MAX_CONSECUTIVE_CHUNK_FAILURES) {
      const reason = results[0]?.error ?? 'endpoint unreachable';
      // Pad rather than truncate: callers index results against their call
      // list, and a short array would silently shift every later contract.
      while (out.length < calls.length) {
        out.push({ ok: false, status: 0, error: `Stopped after repeated failures: ${reason}` });
      }
      opts.onChunk?.(out.length, calls.length);
      break;
    }
  }
  return out;
}

/** Metadata keys read alongside the owner's balance. */
const META_KEYS = [
  OCS01_KEYS.symbol,
  OCS01_KEYS.name,
  OCS01_KEYS.decimals,
  OCS01_KEYS.totalSupply,
] as const;

/**
 * One contract's OCS01 metadata plus this owner's balance.
 *
 * `rawBalance` is null when the balance read FAILED, which is deliberately
 * distinct from a successful read of zero. Callers must not persist a failed
 * read as a zero balance — doing so would erase a real holding whenever the
 * network hiccups.
 */
export interface TokenRead {
  contract: string;
  rawBalance: bigint | null;
  /** The balance key actually exists (as opposed to reading back as absent). */
  balanceEntry: boolean;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: string | null;
}

/** Turn one contract's 5-result slice into a `TokenRead`. */
function parseTokenSlice(
  contract: string,
  slice: ReadonlyArray<RpcResult<{ value?: unknown }>>,
): TokenRead {
  const value = (i: number): unknown => (slice[i]?.ok ? slice[i].result?.value : null);
  const balanceOk = slice[4]?.ok === true;
  const parsed = balanceOk ? parseU128(value(4)) : null;
  return {
    contract,
    rawBalance: balanceOk ? (parsed ?? 0n) : null,
    balanceEntry: balanceOk && parsed !== null,
    symbol: parseText(value(0)),
    name: parseText(value(1)),
    decimals: parseDecimals(value(2)),
    totalSupply: parseU128(value(3))?.toString() ?? null,
  };
}

/**
 * Evidence that a contract is a token at all.
 *
 * A contract that answers null to every key is not a token, and a successful
 * read of an absent key is not evidence.
 */
function looksLikeToken(read: TokenRead): boolean {
  return read.symbol !== null || read.balanceEntry;
}

/** Read metadata + this owner's balance for many contracts, paced. */
async function readTokensAt(
  rpc: RpcClient,
  contracts: readonly string[],
  owner: string,
  opts: { signal?: AbortSignal } = {},
): Promise<TokenRead[]> {
  if (contracts.length === 0) return [];
  const keys = [...META_KEYS, balanceKey(owner)];
  const results = await pacedBatch<{ value?: unknown }>(
    rpc,
    contracts.flatMap((c) =>
      keys.map((k) => ({ method: 'octra_contractStorage', params: [c, k] })),
    ),
    opts,
  );
  return contracts.map((c, i) =>
    parseTokenSlice(c, results.slice(i * keys.length, (i + 1) * keys.length)),
  );
}

/** Read one contract, or null when it shows no sign of being a token. */
async function readTokenAt(
  rpc: RpcClient,
  contract: string,
  owner: string,
): Promise<TokenRead | null> {
  const [read] = await readTokensAt(rpc, [contract], owner);
  return read && looksLikeToken(read) ? read : null;
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
 * One batch for a typical wallet, so this is safe on every panel open, after a
 * transfer, and on every network or account change — unlike a full sweep.
 */
export async function refreshHoldings(
  rpc: RpcClient,
  owner: string,
  signal?: AbortSignal,
): Promise<TokenHolding[]> {
  const existing = await loadCachedHoldings(rpc.url, owner);
  if (existing.length === 0) return [];

  const results = await pacedBatch<{ value?: unknown }>(
    rpc,
    existing.map((h) => ({
      method: 'octra_contractStorage',
      params: [h.contract, balanceKey(owner)],
    })),
    { signal },
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
      deployed: h.deployed,
      updatedAt: Date.now(),
    };
    await saveTokenHolding(entry);
    out.push(toHolding(entry, h.custom));
  }
  return out.sort(compareHoldings);
}

/**
 * True when a full sweep is worth running for this endpoint and address.
 *
 * Reads the recorded outcome of the last sweep, so a sweep that was cancelled
 * or lost chunks to throttling is retried rather than trusted.
 */
export async function isDiscoveryDue(rpcUrl: string, owner: string): Promise<boolean> {
  const record = await getTokenScan(rpcUrl, owner);
  if (record === null || record.completedAt === null) return true;
  return Date.now() - record.completedAt > DISCOVERY_TTL_MS;
}

/**
 * Discover every token this address holds on this endpoint.
 *
 * Phase 1 reads the contracts the address deployed; phase 2 probes the rest.
 * Both phases persist as they go and report through `onHit`, so the list fills
 * in rather than appearing all at once. Honours `signal` promptly.
 *
 * Everything written is scoped by `rpc.url` and `owner`, so a devnet sweep can
 * never surface on mainnet or under another account.
 */
export async function discoverTokens(
  rpc: RpcClient,
  owner: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ScanProgress) => void;
    /** Fired as each token resolves, so the UI can render hits live. */
    onHit?: (holding: TokenHolding) => void;
    /** Refetch the contract list instead of reusing the cached copy. */
    force?: boolean;
  } = {},
): Promise<DiscoveryResult> {
  const { signal, onProgress, onHit } = opts;
  throwIfAborted(signal);

  const registry = await getContractRegistry(rpc, { force: opts.force });
  throwIfAborted(signal);

  const total = registry.addresses.length;
  let scanned = 0;
  let found = 0;
  let unreadable = 0;
  const report = (): void => onProgress?.({ scanned, total, found });
  report();

  // Prior rows and manual entries, read once: the first protects a known
  // balance from a failed read, the second keeps the "added manually" tag on
  // streamed rows.
  const prior = new Map(
    (await listTokenHoldings(rpc.url, owner)).map((r) => [r.contract, r] as const),
  );
  const customSet = new Set((await listCustomTokens(rpc.url, owner)).map((c) => c.contract));

  const persist = async (read: TokenRead, probeRaw: bigint | null, deployed: boolean) => {
    const previous = prior.get(read.contract);
    // Order matters: this read, else the probe that already proved a non-zero
    // balance, else the last known value. Never zero-by-default.
    const raw =
      read.rawBalance ?? probeRaw ?? (previous ? (parseU128(previous.rawBalance) ?? null) : null);
    if (raw === null) return; // nothing trustworthy to record yet

    const entry: TokenHoldingEntry = {
      key: tokenKey(rpc.url, owner, read.contract),
      rpcUrl: rpc.url,
      owner,
      contract: read.contract,
      rawBalance: raw.toString(),
      symbol: read.symbol,
      name: read.name,
      decimals: read.decimals,
      totalSupply: read.totalSupply,
      // Deployment is a fact about the contract, so once true it stays true.
      deployed: deployed || previous?.deployed === true,
      updatedAt: Date.now(),
    };
    await saveTokenHolding(entry);
    found++;
    onHit?.(toHolding(entry, customSet.has(read.contract)));
  };

  // ---- Phase 1: contracts this address deployed ----
  const deployedByMe =
    registry.owners.length === registry.addresses.length
      ? registry.addresses.filter((_, i) => registry.owners[i] === owner)
      : [];

  if (deployedByMe.length > 0) {
    const reads = await readTokensAt(rpc, deployedByMe, owner, { signal });
    for (const read of reads) {
      if (read.rawBalance === null) unreadable++;
      // Zero balance is kept here on purpose: a token you deployed is yours to
      // see whether or not you are holding any of it right now.
      if (looksLikeToken(read)) await persist(read, null, true);
    }
    scanned += deployedByMe.length;
    report();
  }

  // ---- Phase 2: probe everything else ----
  const deployedSet = new Set(deployedByMe);
  const rest = registry.addresses.filter((a) => !deployedSet.has(a));

  const probes = await pacedBatch<{ value?: unknown }>(
    rpc,
    rest.map((a) => ({ method: 'octra_contractStorage', params: [a, balanceKey(owner)] })),
    {
      signal,
      onChunk: (done) => {
        scanned = deployedByMe.length + done;
        report();
      },
    },
  );

  const hits: Array<{ contract: string; raw: bigint }> = [];
  for (let i = 0; i < rest.length; i++) {
    const r = probes[i];
    if (!r?.ok) {
      // A lost probe is not a zero balance. Counting it keeps the caller
      // honest about the sweep being partial.
      unreadable++;
      continue;
    }
    const raw = parseU128(r.result?.value);
    if (raw !== null && raw > 0n) hits.push({ contract: rest[i], raw });
  }

  // Metadata only for hits — a few calls, not thousands.
  if (hits.length > 0) {
    const reads = await readTokensAt(
      rpc,
      hits.map((h) => h.contract),
      owner,
      { signal },
    );
    for (let i = 0; i < reads.length; i++) {
      await persist(reads[i], hits[i].raw, false);
    }
    report();
  }

  const now = Date.now();
  const record = await getTokenScan(rpc.url, owner);
  await saveTokenScan({
    key: scanKey(rpc.url, owner),
    rpcUrl: rpc.url,
    owner,
    attemptedAt: now,
    // Only a sweep that read everything may claim completion; otherwise keep
    // whatever the last complete sweep recorded so the next visit retries.
    completedAt: unreadable === 0 ? now : (record?.completedAt ?? null),
    contractCount: total,
    unreadable,
  });

  return {
    holdings: await loadCachedHoldings(rpc.url, owner),
    unreadable,
    contractCount: total,
  };
}

/**
 * Full sweep, returning just the holdings.
 *
 * Thin wrapper over `discoverTokens` for callers that do not need to know
 * whether the sweep was complete.
 */
export async function scanForTokens(
  rpc: RpcClient,
  owner: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: ScanProgress) => void;
    onHit?: (holding: TokenHolding) => void;
    force?: boolean;
  } = {},
): Promise<TokenHolding[]> {
  return (await discoverTokens(rpc, owner, opts)).holdings;
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

  const nonce = await fetchNextNonce(rpc, wallet.addr);

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
