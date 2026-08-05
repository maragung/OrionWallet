/**
 * WalletProvider — the object exposed as `window.wallet` to dApps.
 *
 * Responsibilities:
 *   - MetaMask-like developer surface (connect, read info, sign, events).
 *   - Request/response correlation over a Transport.
 *   - Nonce generation (replay protection) + timeout handling.
 *   - Event fan-out (connect/disconnect/accountChanged/...).
 *   - Automatic reconnect + session restore.
 *
 * It NEVER exposes transaction-execution methods. The low-level `request()`
 * blocks the prohibited list locally before anything hits the transport, and
 * the wallet re-checks server-side.
 */
import {
  ERROR_CODES,
  EVENTS,
  METHODS,
  canonicalizeMethod,
  isProhibitedMethod,
  makeRequest,
  type Capability,
  type Envelope,
  type WalletEventName,
} from './protocol';
import { PopupTransport } from './transport/PopupTransport';
import type { Transport } from './transport/types';
import { methodForbidden, timeout as timeoutErr, WalletError } from './errors';

export interface WalletProviderOptions {
  /** Absolute URL of the wallet's connect endpoint, e.g. "https://wallet.app/connect". */
  walletUrl: string;
  /** Capabilities to request at connect time. Defaults to all. */
  capabilities?: string[];
  /** Per-request timeout (ms). Default 60s (covers user approval time). */
  requestTimeoutMs?: number;
  /** Provide a custom transport (e.g. for tests). Defaults to PopupTransport. */
  transport?: Transport;
  /** localStorage key for session-restore hints. */
  storageKey?: string;
}

export interface WalletAccount {
  address: string;
  publicKey: string;
  name?: string;
  index?: number;
}

export interface ConnectResult {
  address: string;
  publicKey: string;
  accounts: WalletAccount[];
  network: string;
  chainId: string;
  capabilities: Capability[];
}

export interface SignMessageResult {
  address: string;
  publicKey: string;
  message: string;
  signature: string;
  scheme: string;
}

export interface TypedData {
  domain: { name: string; version: string; chainId?: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignTypedDataResult {
  address: string;
  publicKey: string;
  signature: string;
  hash: string;
  scheme: string;
}

export interface ApproveContractParams {
  program: string;
  method: string;
  spender?: string;
  args?: unknown[];
  limit?: string;
  expiry?: number;
}

export interface SignContractParams {
  program: string;
  method: string;
  args?: unknown[];
  amount?: string;
  ou?: string;
}

type Listener = (payload: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WalletProvider {
  /** For dApp feature-detection: `window.wallet.isOctra`. */
  readonly isOctra = true;

  private readonly opts: Required<Omit<WalletProviderOptions, 'transport' | 'capabilities'>> & {
    capabilities?: string[];
    transport?: Transport;
  };
  private transport: Transport | null = null;
  private readonly makeTransport: () => Transport;

  private nonce = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<WalletEventName, Set<Listener>>();

  private connected = false;
  private connecting: Promise<ConnectResult> | null = null;
  private grantedCapabilities: Capability[] = [];
  private currentAddress: string | null = null;
  private currentNetwork: string | null = null;
  private currentChainId: string | null = null;

  constructor(options: WalletProviderOptions) {
    this.opts = {
      walletUrl: options.walletUrl,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      storageKey: options.storageKey ?? 'octra:wallet:session',
      capabilities: options.capabilities,
      transport: options.transport,
    };
    this.makeTransport = () => options.transport ?? new PopupTransport();
  }

  // ── Connection ───────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected && !!this.transport?.isConnected();
  }

  async connect(): Promise<ConnectResult> {
    if (this.isConnected() && this.currentAddress) {
      return this.snapshot();
    }
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = this.makeTransport();
      this.transport = transport;
      transport.onMessage((env) => this.handleInbound(env));
      transport.onClose((reason) => this.handleClose(reason));

      const hs = await transport.connect({
        walletUrl: this.opts.walletUrl,
        capabilities: this.opts.capabilities,
        timeoutMs: this.opts.requestTimeoutMs,
      });
      this.grantedCapabilities = hs.capabilities as Capability[];

      const result = (await this.request(METHODS.CONNECT, {
        origin: location.origin,
        capabilities: hs.capabilities,
      })) as ConnectResult;

      this.connected = true;
      this.currentAddress = result.address;
      this.currentNetwork = result.network;
      this.currentChainId = result.chainId;
      this.persistSession(result);
      this.emit(EVENTS.CONNECT, result);
      return { ...result, capabilities: this.grantedCapabilities };
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.transport?.isConnected()) {
      try {
        await this.request(METHODS.DISCONNECT, {});
      } catch {
        /* best-effort */
      }
    }
    this.clearSession('user disconnect');
  }

  // ── Read-only wallet information ──────────────────────────────────────────

  async getAccounts(): Promise<WalletAccount[]> {
    return (await this.request(METHODS.GET_ACCOUNTS, {})) as WalletAccount[];
  }

  async getAddress(): Promise<string> {
    return (await this.request(METHODS.GET_ADDRESS, {})) as string;
  }

  async getPublicKey(): Promise<string> {
    return (await this.request(METHODS.GET_PUBLIC_KEY, {})) as string;
  }

  async getBalance(): Promise<{ balance: string; balanceRaw: string; nonce: number }> {
    return (await this.request(METHODS.GET_BALANCE, {})) as {
      balance: string;
      balanceRaw: string;
      nonce: number;
    };
  }

  async getNetwork(): Promise<string> {
    return (await this.request(METHODS.GET_NETWORK, {})) as string;
  }

  async getChainId(): Promise<string> {
    return (await this.request(METHODS.GET_CHAIN_ID, {})) as string;
  }

  async getPermissions(): Promise<string[]> {
    return (await this.request(METHODS.GET_PERMISSIONS, {})) as string[];
  }

  // ── Signing (each opens an approval popup in the wallet) ────────────────────

  async signMessage(message: string): Promise<SignMessageResult> {
    return (await this.request(METHODS.SIGN_MESSAGE, { message })) as SignMessageResult;
  }

  async signTypedData(typedData: TypedData): Promise<SignTypedDataResult> {
    return (await this.request(METHODS.SIGN_TYPED_DATA, { typedData })) as SignTypedDataResult;
  }

  async approveContract(params: ApproveContractParams): Promise<Record<string, unknown>> {
    return (await this.request(METHODS.APPROVE_CONTRACT, params)) as Record<string, unknown>;
  }

  async signContract(params: SignContractParams): Promise<Record<string, unknown>> {
    return (await this.request(METHODS.SIGN_CONTRACT, params)) as Record<string, unknown>;
  }

  // ── Low-level escape hatch (still blocks prohibited methods) ────────────────

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (isProhibitedMethod(method)) {
      // Fail locally without ever contacting the wallet.
      throw methodForbidden(method);
    }
    // Compare canonically so the `orion_wallet_*` alias is recognised as connect
    // and does not trigger a reconnect loop against itself.
    const canonical = canonicalizeMethod(method);
    // Reconnect transparently if the session dropped (auto-reconnect).
    if (canonical !== METHODS.CONNECT && !this.transport?.isConnected()) {
      await this.reconnect();
    }
    const env = makeRequest(method, params, this.nextNonce());
    return this.dispatch<T>(env);
  }

  private dispatch<T>(env: Envelope): Promise<T> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new WalletError(ERROR_CODES.INTERNAL, 'No transport'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(env.id);
        reject(timeoutErr());
      }, this.opts.requestTimeoutMs);
      this.pending.set(env.id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        transport.send(env);
        transport.focus();
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(env.id);
        reject(e);
      }
    });
  }

  // ── Inbound message routing ─────────────────────────────────────────────────

  private handleInbound(env: Envelope): void {
    if (env.kind === 'res') {
      const p = this.pending.get(env.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(env.id);
      if (env.error) p.reject(WalletError.fromWire(env.error));
      else p.resolve(env.result);
      return;
    }
    if (env.kind === 'evt' && env.event) {
      this.onWalletEvent(env.event, env.params);
    }
  }

  private onWalletEvent(event: WalletEventName, payload: unknown): void {
    // Keep local snapshot coherent so reconcile-on-reconnect is accurate.
    switch (event) {
      case EVENTS.ACCOUNT_CHANGED: {
        const p = payload as { address?: string } | undefined;
        if (p?.address) this.currentAddress = p.address;
        break;
      }
      case EVENTS.NETWORK_CHANGED: {
        const p = payload as { network?: string; chainId?: string } | undefined;
        if (p?.network) this.currentNetwork = p.network;
        if (p?.chainId) this.currentChainId = p.chainId;
        break;
      }
      case EVENTS.SESSION_EXPIRED:
      case EVENTS.DISCONNECT:
        this.clearSession(String(event));
        break;
    }
    this.emit(event, payload);
  }

  private handleClose(reason: string): void {
    // Reject anything still in flight; keep session hint for restore.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new WalletError(ERROR_CODES.POPUP_CLOSED, `Channel closed: ${reason}`));
      this.pending.delete(id);
    }
    this.connected = false;
    this.emit(EVENTS.DISCONNECT, { reason });
  }

  private async reconnect(): Promise<void> {
    // Re-run the full handshake + connect. Session hint (if any) lets the
    // wallet restore silently for an already-trusted origin.
    await this.connect();
  }

  // ── Events API ──────────────────────────────────────────────────────────────

  on(event: WalletEventName, listener: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  once(event: WalletEventName, listener: Listener): this {
    const wrap: Listener = (p) => {
      this.off(event, wrap);
      listener(p);
    };
    return this.on(event, wrap);
  }

  off(event: WalletEventName, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: WalletEventName, payload: unknown): void {
    this.listeners.get(event)?.forEach((l) => {
      try {
        l(payload);
      } catch (e) {
        console.error(`[octra-wallet] listener for "${event}" threw`, e);
      }
    });
  }

  // ── Session persistence (restore hint only; no secrets) ─────────────────────

  private persistSession(result: ConnectResult): void {
    try {
      localStorage.setItem(
        this.opts.storageKey,
        JSON.stringify({
          origin: location.origin,
          address: result.address,
          network: result.network,
          chainId: result.chainId,
          ts: Date.now(),
        }),
      );
    } catch {
      /* storage may be unavailable */
    }
  }

  private clearSession(reason: string): void {
    this.connected = false;
    this.currentAddress = null;
    try {
      localStorage.removeItem(this.opts.storageKey);
    } catch {
      /* ignore */
    }
    this.transport?.close(reason);
    this.transport = null;
  }

  /** Whether a prior session hint exists (dApp may auto-call connect()). */
  hasSessionHint(): boolean {
    try {
      const raw = localStorage.getItem(this.opts.storageKey);
      if (!raw) return false;
      const s = JSON.parse(raw) as { origin?: string };
      return s.origin === location.origin;
    } catch {
      return false;
    }
  }

  private snapshot(): ConnectResult {
    return {
      address: this.currentAddress ?? '',
      publicKey: '',
      accounts: [],
      network: this.currentNetwork ?? '',
      chainId: this.currentChainId ?? '',
      capabilities: this.grantedCapabilities,
    };
  }

  private nextNonce(): number {
    return this.nonce++;
  }
}
