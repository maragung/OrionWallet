/**
 * Wallet-side request handler for the SDK connect popup.
 *
 * Security responsibilities (all enforced here, before any wallet action):
 *   - Origin validation: the connecting origin is fixed at handshake and every
 *     inbound envelope is answered only for that origin.
 *   - Challenge-response: the dApp must echo the wallet's random challenge over
 *     the port before any request is served.
 *   - Nonce + replay protection: per-session monotonic nonce plus a freshness
 *     window on `ts`; stale/duplicate/rewound nonces are rejected.
 *   - Prohibited method denylist: sendTransaction/broadcast/transfer/swap/bridge
 *     are rejected with METHOD_FORBIDDEN even via the low-level request path.
 *   - Per-request approval: every sign opens an approval prompt; reads are
 *     served silently within a live session.
 *
 * The handler is decoupled from React through the `WalletHost` interface so it
 * can be unit-tested without a DOM.
 */
import {
  ERROR_CODES,
  EVENTS,
  METHODS,
  canonicalizeMethod,
  isEnvelope,
  isProhibitedMethod,
  makeError,
  makeEvent,
  makeResponse,
  negotiateCapabilities,
  type Capability,
  type Envelope,
  type HelloAck,
  type WalletEventName,
  type WireError,
} from '../sdk/protocol';
import type { Wallet } from '../wallet/wallet';
import {
  signPlainMessage,
  signTypedDataOctra,
  signContractApproval,
  signContractCall,
  type TypedData,
  type ApproveContractParams,
  type SignContractParams,
} from './typed-data';
import {
  createSession,
  restoreSession,
  touchSession,
  endSession,
  hasPermission,
  grantPermission,
  DEFAULT_PERMISSIONS,
  SIGNING_PERMISSIONS,
} from './session';
import { siteIsTrusted } from './trusted-sites';
import type { SdkSessionRecord } from '../wallet/storage';

/** How far an inbound `ts` may drift from local time (ms). */
const FRESHNESS_WINDOW_MS = 30_000;

export type ApprovalKind =
  'connect' | 'signMessage' | 'signTypedData' | 'approveContract' | 'signContract';

export interface ApprovalRequest {
  kind: ApprovalKind;
  origin: string;
  /** Human-readable payload for the UI to render. */
  detail: Record<string, unknown>;
}

/** Environment the handler needs from the wallet app. */
export interface WalletHost {
  /** The unlocked wallet, or null when locked. */
  getWallet(): Wallet | null;
  /** Whether the wallet is currently unlocked. */
  isUnlocked(): boolean;
  /** Active account address. */
  getAddress(): string | null;
  /** All accounts (multi-account support). */
  getAccounts(): Array<{ address: string; publicKey: string; name?: string; index?: number }>;
  /** Network name (e.g. "devnet"). */
  getNetwork(): string;
  /** Chain id string. */
  getChainId(): Promise<string>;
  /** Read balance for the active account. */
  getBalance(): Promise<{ balance: string; balanceRaw: string; nonce: number }>;
  /** Fetch the next nonce for building a contract call. */
  getNextNonce(): Promise<number>;
  /**
   * Ask the user to approve an action. Resolves true (approved) / false
   * (rejected). Reads never call this; every sign does.
   */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
}

interface ReplayState {
  lastNonce: number;
  seen: Set<number>;
}

export class ConnectHandler {
  private readonly host: WalletHost;
  private readonly port: MessagePort;
  private readonly origin: string;
  private readonly challenge: string;
  private readonly requestedCaps: Capability[];

  private acked = false;
  private capabilities: Capability[] = [];
  private session: SdkSessionRecord | null = null;
  private outboundNonce = 1;
  private readonly replay: ReplayState = { lastNonce: 0, seen: new Set() };
  private disposed = false;

  constructor(input: {
    host: WalletHost;
    port: MessagePort;
    origin: string;
    challenge: string;
    requestedCapabilities?: string[];
  }) {
    this.host = input.host;
    this.port = input.port;
    this.origin = input.origin;
    this.challenge = input.challenge;
    this.capabilities = negotiateCapabilities(input.requestedCapabilities);
    this.requestedCaps = this.capabilities;
    this.port.onmessage = (e) => this.onMessage(e);
    this.port.start?.();
  }

  /** Emit a wallet event to the connected dApp (bounded to this session). */
  emitEvent(event: WalletEventName, payload: unknown): void {
    if (this.disposed) return;
    this.port.postMessage(makeEvent(event, payload, this.outboundNonce++));
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.port.close();
    } catch {
      /* ignore */
    }
  }

  // ── Inbound routing ─────────────────────────────────────────────────────────

  private onMessage(e: MessageEvent): void {
    const data = e.data;

    // First port message must be the HelloAck (challenge echo).
    if (!this.acked) {
      const ack = (data as { __ack?: HelloAck } | undefined)?.__ack;
      if (!ack) return;
      if (ack.challenge !== this.challenge) {
        this.port.postMessage(
          makeError(
            'handshake',
            { code: ERROR_CODES.CHALLENGE_FAILED, message: 'Challenge mismatch' },
            this.outboundNonce++,
          ),
        );
        this.dispose();
        return;
      }
      if (ack.origin !== this.origin) {
        this.port.postMessage(
          makeError(
            'handshake',
            { code: ERROR_CODES.ORIGIN_MISMATCH, message: 'Origin mismatch in ack' },
            this.outboundNonce++,
          ),
        );
        this.dispose();
        return;
      }
      this.acked = true;
      return;
    }

    if (!isEnvelope(data)) return;
    const env = data as Envelope;
    if (env.kind !== 'req' || !env.method) return;
    void this.handleRequest(env);
  }

  private replayCheck(env: Envelope): WireError | null {
    const now = Date.now();
    if (typeof env.ts !== 'number' || Math.abs(now - env.ts) > FRESHNESS_WINDOW_MS) {
      return { code: ERROR_CODES.REPLAY_DETECTED, message: 'Stale message timestamp' };
    }
    if (typeof env.nonce !== 'number' || env.nonce <= this.replay.lastNonce) {
      return { code: ERROR_CODES.REPLAY_DETECTED, message: 'Nonce not increasing' };
    }
    if (this.replay.seen.has(env.nonce)) {
      return { code: ERROR_CODES.REPLAY_DETECTED, message: 'Duplicate nonce' };
    }
    this.replay.lastNonce = env.nonce;
    this.replay.seen.add(env.nonce);
    // Bound memory; nonces only ever increase so old entries are safe to drop.
    if (this.replay.seen.size > 512) this.replay.seen.clear();
    return null;
  }

  private reply(id: string, result: unknown): void {
    if (this.disposed) return;
    this.port.postMessage(makeResponse(id, result, this.outboundNonce++));
  }

  private fail(id: string, error: WireError): void {
    if (this.disposed) return;
    this.port.postMessage(makeError(id, error, this.outboundNonce++));
  }

  // ── Request dispatch ─────────────────────────────────────────────────────────

  private async handleRequest(env: Envelope): Promise<void> {
    const rawMethod = env.method!;
    const method = canonicalizeMethod(rawMethod);

    // Denylist first — nothing that executes a transaction is ever reachable.
    // Check BOTH the raw name and the canonical form: the alias namespace must
    // never become a way to smuggle a prohibited method past the check.
    if (isProhibitedMethod(rawMethod) || isProhibitedMethod(method)) {
      return this.fail(env.id, {
        code: ERROR_CODES.METHOD_FORBIDDEN,
        message:
          `Method "${rawMethod}" is prohibited. Sending, broadcasting, transferring, ` +
          `swapping, and bridging are only available inside the wallet UI.`,
      });
    }

    // Replay/freshness on every request.
    const replayErr = this.replayCheck(env);
    if (replayErr) return this.fail(env.id, replayErr);

    try {
      switch (method) {
        case METHODS.CONNECT:
          return await this.onConnect(env);
        case METHODS.DISCONNECT:
          return await this.onDisconnect(env);
        case METHODS.GET_ACCOUNTS:
        case METHODS.GET_ADDRESS:
        case METHODS.GET_PUBLIC_KEY:
        case METHODS.GET_BALANCE:
        case METHODS.GET_NETWORK:
        case METHODS.GET_CHAIN_ID:
        case METHODS.GET_PERMISSIONS:
          return await this.onRead(env, method);
        case METHODS.SIGN_MESSAGE:
        case METHODS.SIGN_TYPED_DATA:
        case METHODS.APPROVE_CONTRACT:
        case METHODS.SIGN_CONTRACT:
          return await this.onSign(env, method);
        default:
          return this.fail(env.id, {
            code: ERROR_CODES.METHOD_NOT_FOUND,
            message: `Unknown method "${rawMethod}"`,
          });
      }
    } catch (e) {
      return this.fail(env.id, {
        code: ERROR_CODES.INTERNAL,
        message: (e as Error).message ?? 'Internal error',
      });
    }
  }

  // ── Connect / disconnect ─────────────────────────────────────────────────────

  private async onConnect(env: Envelope): Promise<void> {
    if (!this.host.isUnlocked()) {
      return this.fail(env.id, { code: ERROR_CODES.WALLET_LOCKED, message: 'Wallet is locked' });
    }

    // Session restore: a live session for this origin reconnects silently.
    let session = await restoreSession(this.origin);

    // Otherwise, trusted sites skip ONLY the connect prompt.
    if (!session) {
      const trusted = await siteIsTrusted(this.origin);
      const approved =
        trusted ||
        (await this.host.requestApproval({
          kind: 'connect',
          origin: this.origin,
          detail: { capabilities: this.requestedCaps },
        }));
      if (!approved) {
        return this.fail(env.id, {
          code: ERROR_CODES.USER_REJECTED,
          message: 'User rejected the connection',
        });
      }
      const address = this.host.getAddress() ?? '';
      session = await createSession({
        origin: this.origin,
        address,
        accounts: this.host.getAccounts().map((a) => a.address),
        network: this.host.getNetwork(),
        chainId: await this.host.getChainId(),
        permissions: DEFAULT_PERMISSIONS,
      });
    }
    this.session = await touchSession(session);

    const address = this.host.getAddress() ?? this.session.address;
    const accounts = this.host.getAccounts();
    const pk = accounts.find((a) => a.address === address)?.publicKey ?? '';
    this.reply(env.id, {
      address,
      publicKey: pk,
      accounts,
      network: this.host.getNetwork(),
      chainId: await this.host.getChainId(),
      capabilities: this.capabilities,
      sessionId: this.session.sid,
    });
  }

  private async onDisconnect(env: Envelope): Promise<void> {
    if (this.session) {
      await endSession(this.session.sid);
      this.session = null;
    }
    this.reply(env.id, { ok: true });
    this.emitEvent(EVENTS.DISCONNECT, { reason: 'dApp requested' });
  }

  // ── Reads (session-silent) ───────────────────────────────────────────────────

  private async requireSession(id: string): Promise<SdkSessionRecord | null> {
    if (!this.session) {
      this.fail(id, { code: ERROR_CODES.UNAUTHORIZED, message: 'Not connected' });
      return null;
    }
    // Refresh idle TTL; if it expired between calls, surface it.
    const now = Date.now();
    if (this.session.absExpiresAt <= now || this.session.idleExpiresAt <= now) {
      await endSession(this.session.sid);
      this.emitEvent(EVENTS.SESSION_EXPIRED, { origin: this.origin });
      this.session = null;
      this.fail(id, { code: ERROR_CODES.SESSION_EXPIRED, message: 'Session expired' });
      return null;
    }
    this.session = await touchSession(this.session);
    return this.session;
  }

  private async onRead(env: Envelope, method: string): Promise<void> {
    const session = await this.requireSession(env.id);
    if (!session) return;
    if (!this.host.isUnlocked()) {
      return this.fail(env.id, { code: ERROR_CODES.WALLET_LOCKED, message: 'Wallet is locked' });
    }

    switch (method) {
      case METHODS.GET_ACCOUNTS:
        return this.reply(env.id, this.host.getAccounts());
      case METHODS.GET_ADDRESS:
        return this.reply(env.id, this.host.getAddress());
      case METHODS.GET_PUBLIC_KEY: {
        const addr = this.host.getAddress();
        const pk = this.host.getAccounts().find((a) => a.address === addr)?.publicKey ?? '';
        return this.reply(env.id, pk);
      }
      case METHODS.GET_BALANCE:
        return this.reply(env.id, await this.host.getBalance());
      case METHODS.GET_NETWORK:
        return this.reply(env.id, this.host.getNetwork());
      case METHODS.GET_CHAIN_ID:
        return this.reply(env.id, await this.host.getChainId());
      case METHODS.GET_PERMISSIONS:
        return this.reply(env.id, session.permissions);
    }
  }

  // ── Signing (always prompt) ──────────────────────────────────────────────────

  private async onSign(env: Envelope, method: string): Promise<void> {
    const session = await this.requireSession(env.id);
    if (!session) return;
    if (!this.host.isUnlocked()) {
      return this.fail(env.id, { code: ERROR_CODES.WALLET_LOCKED, message: 'Wallet is locked' });
    }
    const wallet = this.host.getWallet();
    if (!wallet) {
      return this.fail(env.id, { code: ERROR_CODES.WALLET_LOCKED, message: 'Wallet is locked' });
    }

    const perm = this.permissionForMethod(method);
    // Signing scopes are not granted at connect time — they are granted the
    // first time the user approves that specific operation. Rejecting here
    // would make every sign fail with UNAUTHORIZED before the prompt could ever
    // appear, which is exactly the "connect works, nothing else does" symptom.
    //
    // A scope the user has explicitly revoked is still refused: revocation
    // removes it from `permissions` AND records it in `deniedPermissions`.
    const isSigningScope = (SIGNING_PERMISSIONS as readonly string[]).includes(perm);
    const revoked = session.deniedPermissions?.includes(perm) ?? false;
    if (revoked || (!isSigningScope && !hasPermission(session, perm))) {
      return this.fail(env.id, {
        code: ERROR_CODES.UNAUTHORIZED,
        message: `Permission "${perm}" not granted`,
      });
    }

    switch (method) {
      case METHODS.SIGN_MESSAGE: {
        const raw = env.params as { message?: unknown; scheme?: unknown } | undefined;
        const message = String(raw?.message ?? '');
        // Only the two known schemes are honoured; anything else falls back to
        // the domain-separated default rather than silently signing raw bytes.
        const scheme: 'raw' | 'domain' = raw?.scheme === 'raw' ? 'raw' : 'domain';
        const approved = await this.host.requestApproval({
          kind: 'signMessage',
          origin: this.origin,
          // Surface the scheme so the approval UI can warn on untagged signing.
          detail: { message, scheme },
        });
        if (!approved) return this.rejected(env.id);
        // Grant permission on first successful approval, so subsequent calls do
        // not hit the permission check and can proceed straight to the prompt.
        this.session = await grantPermission(session, 'signMessage');
        return this.reply(env.id, signPlainMessage(wallet, { message, scheme }));
      }
      case METHODS.SIGN_TYPED_DATA: {
        const td = (env.params as { typedData?: TypedData })?.typedData;
        if (!td || !td.primaryType || !td.types) {
          return this.fail(env.id, {
            code: ERROR_CODES.INVALID_PARAMS,
            message: 'Malformed typed data',
          });
        }
        const approved = await this.host.requestApproval({
          kind: 'signTypedData',
          origin: this.origin,
          detail: { typedData: td as unknown as Record<string, unknown> },
        });
        if (!approved) return this.rejected(env.id);
        this.session = await grantPermission(session, 'signTypedData');
        return this.reply(env.id, signTypedDataOctra(wallet, td));
      }
      case METHODS.APPROVE_CONTRACT: {
        const params = env.params as ApproveContractParams;
        if (!params?.program || !params?.method) {
          return this.fail(env.id, {
            code: ERROR_CODES.INVALID_PARAMS,
            message: 'approveContract requires program and method',
          });
        }
        const approved = await this.host.requestApproval({
          kind: 'approveContract',
          origin: this.origin,
          detail: { ...params },
        });
        if (!approved) return this.rejected(env.id);
        this.session = await grantPermission(session, 'approveContract');
        return this.reply(env.id, signContractApproval(wallet, params));
      }
      case METHODS.SIGN_CONTRACT: {
        const params = env.params as Omit<SignContractParams, 'nonce'>;
        if (!params?.program || !params?.method) {
          return this.fail(env.id, {
            code: ERROR_CODES.INVALID_PARAMS,
            message: 'signContract requires program and method',
          });
        }
        const approved = await this.host.requestApproval({
          kind: 'signContract',
          origin: this.origin,
          detail: { ...params },
        });
        if (!approved) return this.rejected(env.id);
        this.session = await grantPermission(session, 'signContract');
        const nonce = await this.host.getNextNonce();
        const signed = signContractCall(wallet, { ...params, nonce });
        // Return the SIGNED tx only — never submitted here.
        return this.reply(env.id, {
          signedTransaction: signed.tx,
          program: signed.program,
          method: signed.method,
          note: 'Signed only. Submit via the wallet UI; the SDK cannot broadcast.',
        });
      }
    }
  }

  private permissionForMethod(method: string): string {
    switch (method) {
      case METHODS.SIGN_MESSAGE:
        return 'signMessage';
      case METHODS.SIGN_TYPED_DATA:
        return 'signTypedData';
      case METHODS.APPROVE_CONTRACT:
        return 'approveContract';
      case METHODS.SIGN_CONTRACT:
        return 'signContract';
      default:
        return 'unknown';
    }
  }

  private rejected(id: string): void {
    this.fail(id, { code: ERROR_CODES.USER_REJECTED, message: 'User rejected the request' });
  }
}
