/**
 * Octra RPC client (JSON-RPC 2.0 over HTTP POST).
 *
 * The Octra RPC uses JSON-RPC 2.0 protocol:
 *   POST to RPC URL
 *   Body: {"jsonrpc":"2.0","method":"<method>","params":[<params>],"id":<id>}
 *   Response: {"jsonrpc":"2.0","result":<data>,"id":<id>}
 *             or {"jsonrpc":"2.0","error":{"code":<code>,"message":<msg>},"id":<id>}
 *
 * Key methods (from original rpc_client.hpp + octrascan explorer):
 *   - octra_balance(addr) → {balance, nonce, encrypted_balance, ...}
 *   - octra_account(addr, limit) → transaction history
 *   - octra_transaction(hash) → single transaction
 *   - octra_submit(tx) → submit signed transaction
 *   - octra_publicKey(addr) → recipient's public key (for stealth)
 *   - node_status() → network status
 *   - octra_recommendedFee() → fee schedule
 */

export interface RpcClientOptions {
  /** RPC URL (e.g., "https://devnet.octrascan.io/rpc"). */
  url: string;
  /** Optional CORS proxy prefix (e.g., "https://cors.example.com/?url="). */
  proxyUrl?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export interface RpcResult<T = unknown> {
  ok: boolean;
  status: number;
  result?: T;
  error?: string;
}

let rpcIdCounter = 1;

/**
 * Maximum calls per batch request.
 *
 * The node's hard limit is 100 (verified on both devnet and mainnet: sending
 * 101 returns `-32602 "batch size 101 exceeds limit 100"` and discards the
 * entire batch). We use half of that so a future tightening of the server
 * limit degrades throughput rather than breaking outright.
 */
export const BATCH_MAX = 50;

/**
 * Pull a JSON-RPC error message out of a response envelope.
 * Returns null when the envelope carries no error.
 */
function extractRpcError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return null;
  const err = (parsed as { error: unknown }).error;
  if (err && typeof err === 'object') {
    const e = err as { code?: number; message?: string; data?: unknown };
    const base = e.message ?? `RPC error code ${e.code}`;
    // The node puts the actionable detail in `data` (e.g. which param is
    // missing, or the batch-size limit), so keep it.
    return typeof e.data === 'string' ? `${base}: ${e.data}` : base;
  }
  return String(err);
}

export class RpcClient {
  readonly url: string;
  readonly proxyUrl?: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RpcClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.proxyUrl = opts.proxyUrl;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Build the final URL (with optional proxy prefix). */
  private endpoint(): string {
    if (this.proxyUrl) {
      return `${this.proxyUrl}${encodeURIComponent(this.url)}`;
    }
    return this.url;
  }

  /**
   * Send a JSON-RPC 2.0 request.
   * @param method RPC method name (e.g., "octra_balance")
   * @param params Array of parameters
   */
  async rpcCall<T = unknown>(method: string, params: unknown[] = []): Promise<RpcResult<T>> {
    const id = rpcIdCounter++;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      };

      // For proxied requests, send the RPC body directly (proxy forwards it)
      const targetUrl = this.endpoint();
      const res = await this.fetchImpl(targetUrl, init);
      const text = await res.text();

      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON response (e.g., HTML error page)
        return {
          ok: false,
          status: res.status,
          error: `Non-JSON response (${res.status}): ${text.slice(0, 200)}`,
        };
      }

      if (!res.ok) {
        const errMsg =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? typeof (parsed as { error: unknown }).error === 'object'
              ? ((parsed as { error: { message?: string } }).error?.message ?? `HTTP ${res.status}`)
              : String((parsed as { error: unknown }).error)
            : `HTTP ${res.status}`;
        return { ok: false, status: res.status, error: errMsg };
      }

      // Check for JSON-RPC error
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const rpcErr = (parsed as { error: { code?: number; message?: string } }).error;
        return {
          ok: false,
          status: res.status,
          error: rpcErr?.message ?? `RPC error code ${rpcErr?.code}`,
        };
      }

      // Extract result
      const result = (parsed as { result?: T })?.result;
      return { ok: true, status: res.status, result: result as T };
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        status: 0,
        error:
          err.name === 'AbortError' ? `Request timed out after ${this.timeoutMs}ms` : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a JSON-RPC 2.0 BATCH request (array body).
   *
   * The node enforces a hard batch limit of 100 and rejects the WHOLE batch
   * with `-32602 "batch size N exceeds limit 100"` when exceeded — so an
   * oversized batch loses every call in it, not just the overflow. We cap at
   * BATCH_MAX (50, deliberately half the limit) and chunk above that.
   *
   * Responses are correlated by `id` and returned in REQUEST order, because
   * JSON-RPC explicitly permits a server to reply out of order. A missing id
   * yields an error entry rather than a silent hole: for balance probing, a
   * dropped response would masquerade as "no holding" and hide real funds.
   */
  async rpcBatch<T = unknown>(
    calls: ReadonlyArray<{ method: string; params?: unknown[] }>,
  ): Promise<Array<RpcResult<T>>> {
    if (calls.length === 0) return [];

    const out: Array<RpcResult<T>> = [];
    for (let offset = 0; offset < calls.length; offset += BATCH_MAX) {
      const chunk = calls.slice(offset, offset + BATCH_MAX);
      out.push(...(await this.batchChunk<T>(chunk)));
    }
    return out;
  }

  /** Execute one batch chunk (already <= BATCH_MAX). */
  private async batchChunk<T>(
    chunk: ReadonlyArray<{ method: string; params?: unknown[] }>,
  ): Promise<Array<RpcResult<T>>> {
    // Tag each call with a unique id so responses can be matched even if the
    // node reorders them.
    const ids = chunk.map(() => rpcIdCounter++);
    const body = JSON.stringify(
      chunk.map((c, i) => ({
        jsonrpc: '2.0',
        method: c.method,
        params: c.params ?? [],
        id: ids[i],
      })),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      const text = await res.text();

      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        return this.batchFailure<T>(
          chunk.length,
          res.status,
          `Non-JSON response (${res.status}): ${text.slice(0, 200)}`,
        );
      }

      // A batch-level error (not an array) fails every call in the chunk —
      // this is what an over-limit batch returns.
      if (!Array.isArray(parsed)) {
        const errMsg = extractRpcError(parsed) ?? `HTTP ${res.status}`;
        return this.batchFailure<T>(chunk.length, res.status, errMsg);
      }

      const byId = new Map<number, unknown>();
      for (const entry of parsed) {
        const id = (entry as { id?: unknown })?.id;
        if (typeof id === 'number') byId.set(id, entry);
      }

      return ids.map((id) => {
        const entry = byId.get(id);
        if (entry === undefined) {
          // Never coerce a missing response into a successful empty result.
          return { ok: false, status: res.status, error: 'No response for batch id' };
        }
        const err = extractRpcError(entry);
        if (err !== null) return { ok: false, status: res.status, error: err };
        return { ok: true, status: res.status, result: (entry as { result?: T }).result };
      });
    } catch (e) {
      const err = e as Error;
      return this.batchFailure<T>(
        chunk.length,
        0,
        err.name === 'AbortError' ? `Request timed out after ${this.timeoutMs}ms` : err.message,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build a uniform failure array so callers always get one result per call. */
  private batchFailure<T>(n: number, status: number, error: string): Array<RpcResult<T>> {
    return Array.from({ length: n }, () => ({ ok: false, status, error }));
  }

  // ===== High-level RPC methods =====

  /** Get the wallet's public balance, encrypted balance, and nonce. */
  async getBalance(addr: string): Promise<RpcResult<BalanceInfo>> {
    return this.rpcCall<BalanceInfo>('octra_balance', [addr]);
  }

  /**
   * List every deployed contract on the chain.
   *
   * Returns the full set in a single call (~2k entries on mainnet, ~6.5k on
   * devnet), so callers should cache it rather than refetching per view.
   */
  async listContracts(): Promise<RpcResult<ContractListEntry[]>> {
    const r = await this.rpcCall<{ contracts?: ContractListEntry[] }>('octra_listContracts', []);
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    const contracts = r.result?.contracts;
    if (!Array.isArray(contracts)) {
      return { ok: false, status: r.status, error: 'Malformed listContracts response' };
    }
    return { ok: true, status: r.status, result: contracts };
  }

  /** Get transaction history for an address (paginated). */
  async getHistory(addr: string, limit: number = 50): Promise<RpcResult<HistoryEntry[]>> {
    return this.rpcCall<HistoryEntry[]>('octra_account', [addr, limit]);
  }

  /** Look up a single transaction by hash. */
  async getTx(hash: string): Promise<RpcResult<HistoryEntry>> {
    return this.rpcCall<HistoryEntry>('octra_transaction', [hash]);
  }

  /** Submit a signed transaction. */
  async submitTx(tx: unknown): Promise<RpcResult<SubmitTxResult>> {
    return this.rpcCall<SubmitTxResult>('octra_submit', [tx]);
  }

  /** Get a public key for an address (used by stealth send). */
  async getPublicKey(addr: string): Promise<RpcResult<{ public_key: string }>> {
    return this.rpcCall<{ public_key: string }>('octra_publicKey', [addr]);
  }

  /** Get encrypted balance ciphertext for an address.
   *
   * Requires a signed request: sig_b64 = ed25519("octra_encryptedBalance|<addr>").
   * Mirrors RpcClient::get_encrypted_balance in the reference webcli.
   */
  async getEncryptedBalance(
    addr: string,
    sigB64: string,
    pubB64: string,
  ): Promise<RpcResult<{ cipher: string }>> {
    return this.rpcCall<{ cipher: string }>('octra_encryptedBalance', [addr, sigB64, pubB64]);
  }

  /** Get the unauthenticated encrypted cipher for an address. */
  async getEncryptedCipher(addr: string): Promise<RpcResult<{ cipher: string }>> {
    return this.rpcCall<{ cipher: string }>('octra_encryptedCipher', [addr]);
  }

  /** Get the registered PVAC (FHE) public key for an address. */
  async getPvacPubkey(addr: string): Promise<RpcResult<{ pvac_pubkey: string | null }>> {
    return this.rpcCall<{ pvac_pubkey: string | null }>('octra_pvacPubkey', [addr]);
  }

  /** Register the wallet's PVAC public key on-chain. */
  async registerPvacPubkey(
    addr: string,
    pkB64: string,
    sigB64: string,
    pubB64: string,
    aesKatHex: string = '',
  ): Promise<RpcResult<unknown>> {
    return this.rpcCall<unknown>('octra_registerPvacPubkey', [
      addr,
      pkB64,
      sigB64,
      pubB64,
      aesKatHex,
    ]);
  }

  /** Get the recommended fee schedule. */
  async getFee(): Promise<RpcResult<FeeSchedule>> {
    return this.rpcCall<FeeSchedule>('octra_recommendedFee', []);
  }

  /** Get node status (network info). */
  async getNodeStatus(): Promise<RpcResult<NodeStatus>> {
    return this.rpcCall<NodeStatus>('node_status', []);
  }

  /** Get recent transactions (network-wide). */
  async getRecentTransactions(
    limit: number = 20,
  ): Promise<RpcResult<{ transactions: HistoryEntry[] }>> {
    return this.rpcCall<{ transactions: HistoryEntry[] }>('octra_recentTransactions', [limit]);
  }

  /** Compile AML source code on the RPC node. */
  async compileAml(source: string): Promise<RpcResult<{ bytecode: string; abi?: unknown }>> {
    return this.rpcCall<{ bytecode: string; abi?: unknown }>('octra_compileAml', [{ source }]);
  }

  /** Compile an AML project (multiple files). */
  async compileProject(
    files: Record<string, string>,
  ): Promise<RpcResult<{ bytecode: string; abi?: unknown }>> {
    return this.rpcCall<{ bytecode: string; abi?: unknown }>('octra_compileAmlMulti', [files]);
  }

  /** Get a contract's storage value for a specific key.
   *
   * The node's octra_contractStorage requires BOTH the address AND a storage
   * key ([addr, key] or [addr, key, limit]) — calling it with just [addr]
   * returns "invalid params". Mirrors RpcClient::contract_storage.
   */
  async getContractStorage(
    addr: string,
    key: string,
    limit?: string,
  ): Promise<RpcResult<{ value: unknown; size?: number; truncated?: boolean; limit?: number }>> {
    const params = limit ? [addr, key, limit] : [addr, key];
    return this.rpcCall<{ value: unknown; size?: number; truncated?: boolean; limit?: number }>(
      'octra_contractStorage',
      params,
    );
  }

  /** Get program info for a contract address. */
  async getProgramInfo(addr: string): Promise<RpcResult<unknown>> {
    return this.rpcCall<unknown>('vm_contract', [addr]);
  }

  /** Get supply info. */
  async getSupply(): Promise<RpcResult<SupplyInfo>> {
    return this.rpcCall<SupplyInfo>('octra_supply', []);
  }

  /** Get staging area view (pending transactions). */
  async getStagingView(): Promise<RpcResult<unknown>> {
    return this.rpcCall<unknown>('staging_view', []);
  }
}

// ===== RPC types (mirrors Octra schema) =====

export interface BalanceInfo {
  addr?: string;
  balance: string; // human-readable OCT (e.g., "94.231308")
  balance_raw?: string; // raw integer string (e.g., "94231308")
  nonce: number;
  pending_nonce?: number;
  encrypted_balance?: string; // cipher string or "0"
  has_public_key?: boolean;
  pending?: boolean;
}

export interface FeeSchedule {
  minimum: string;
  base_fee: string;
  recommended: string;
  fast: string;
  staging_size?: number;
  staging_ou?: string;
  epoch_capacity?: string;
  usage_pct?: number;
  stealth_class?: boolean;
  [key: string]: unknown; // allow additional fields
}

export interface SubmitTxResult {
  hash: string;
  nonce: number;
  accepted: boolean;
  message?: string;
}

export interface HistoryEntry {
  hash: string;
  from: string;
  to_: string; // node serializes recipient as "to_" (trailing underscore)
  to?: string; // alias kept for local cached entries built before this fix
  amount: string;
  nonce: number;
  ou: string;
  timestamp: number;
  op_type: string;
  signature: string;
  public_key: string;
  message?: string;
  encrypted_data?: string;
  status?: 'pending' | 'confirmed' | 'failed';
  block_height?: number;
}

export interface NodeStatus {
  chain_id?: string;
  current_epoch?: number;
  current_height?: number;
  total_accounts?: number;
  total_transactions?: number;
  total_supply?: string;
  finalized_height?: number;
  peers?: number;
  version?: string;
}

export interface SupplyInfo {
  circulating?: string;
  burned?: string;
  total?: string;
}

/** One entry from `octra_listContracts`. */
export interface ContractListEntry {
  address: string;
  owner: string;
  code_hash: string;
  version?: string;
  /** Native OCT balance held BY the contract (not a token balance). */
  balance?: string;
}

/** Health-check the RPC endpoint. */
export async function pingRpc(url: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const client = new RpcClient({ url, fetchImpl, timeoutMs: 5000 });
  const r = await client.getNodeStatus();
  return r.ok;
}
