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

  // ===== High-level RPC methods =====

  /** Get the wallet's public balance, encrypted balance, and nonce. */
  async getBalance(addr: string): Promise<RpcResult<BalanceInfo>> {
    return this.rpcCall<BalanceInfo>('octra_balance', [addr]);
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

/** Health-check the RPC endpoint. */
export async function pingRpc(url: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const client = new RpcClient({ url, fetchImpl, timeoutMs: 5000 });
  const r = await client.getNodeStatus();
  return r.ok;
}
