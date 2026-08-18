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
import { isWatchOnly } from '../wallet/watch-only';
import type { NetworkInfo } from '../wallet/networks';
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
import { siteIsTrusted, trustSite } from './trusted-sites';
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
  /**
   * Accounts the user may choose between when approving a `connect`. Present
   * only when the wallet has more than one account. When the user picks one,
   * the UI resolves the approval with exactly that account in this list.
   */
  accounts?: Array<{ address: string; publicKey: string; name?: string; index?: number }>;
}

/** Resolution of an approval prompt. `trust` is only meaningful for `connect`. */
export interface ApprovalDecision {
  approved: boolean;
  /** Persist the origin as trusted (skips only the connect prompt next time). */
  trust?: boolean;
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
  /** Network id (e.g. "devnet", or a custom network's slug). */
  getNetwork(): string;
  /**
   * The active network as a structured record. Wire-safe by construction —
   * see `NetworkInfo` for what is deliberately left out.
   */
  getNetworkInfo(): NetworkInfo;
  /** Every network the wallet offers, including user-added ones. */
  getNetworks(): NetworkInfo[];
  /** Chain id string. */
  getChainId(): Promise<string>;
  /** Read balance for the active account. */
  getBalance(): Promise<{ balance: string; balanceRaw: string; nonce: number }>;
  /** Fetch the next nonce for building a contract call. */
  getNextNonce(): Promise<number>;
  /**
   * Ask the user to approve an action. Resolves with the decision (approved /
   * rejected, plus an optional `trust` flag for `connect`). Reads never call
   * this; every sign does.
   */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /**
   * Ask the wallet UI to prompt for unlock when a request arrives while locked.
   * Resolves true if unlocked, false if cancelled/failed. Multiple concurrent
   * requests should coalesce into one unlock prompt via the implementation.
   */
  requestUnlock(): Promise<boolean>;
  /**
   * Load the signing keys for a specific account. The account may differ from
   * the wallet's currently-active (unlocked-in-memory) account, so the UI must
   * prompt for the PIN and decrypt it. Resolves null when the user cancels or
   * the PIN is wrong. Does NOT change the wallet's active account.
   */
  requestUnlockAccount(addr: string): Promise<Wallet | null>;
  /** Tell the wallet UI which account is bound to the current session. */
  setSessionAccount(addr: string): void;
  /** The account bound to the current session, or null. */
  getSessionAccount(): string | null;
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
  /** Account bound to this session (chosen at connect; may differ from the
   *  wallet's active account). Falls back to the wallet's active account. */
  private sessionAddress: string | null = null;
  /** Signing keys for the session account. Null until requested; the wallet's
   *  active wallet is used as a fallback for the active account. */
  private sessionWallet: Wallet | null = null;
  private outboundNonce = 1;
  private readonly replay: ReplayState = { lastNonce: 0, seen: new Set() };
  private disposed = false;
  /** Requests currently being processed (see getInFlightCount). */
  private inFlight = 0;
  /** Notified whenever the live session id changes (connect/disconnect/expiry). */
  private readonly onSessionChange?: (sid: string | null) => void;
  /**
   * Notified once a `connect` has been fully established and its response sent.
   * Used by the popup to hand the port off to the long-lived main wallet window
   * so the session survives the popup closing.
   */
  private readonly onConnected?: (info: {
    sid: string;
    wallet: Wallet | null;
    address: string | null;
    challenge: string;
    capabilities: Capability[];
  }) => void;

  constructor(input: {
    host: WalletHost;
    port: MessagePort;
    origin: string;
    challenge: string;
    requestedCapabilities?: string[];
    onSessionChange?: (sid: string | null) => void;
    onConnected?: (info: {
      sid: string;
      wallet: Wallet | null;
      address: string | null;
      challenge: string;
      capabilities: Capability[];
    }) => void;
    /** Skip the HelloAck challenge wait (used when adopting a handed-off port). */
    presetAcked?: boolean;
  }) {
    this.host = input.host;
    this.port = input.port;
    this.origin = input.origin;
    this.challenge = input.challenge;
    this.capabilities = negotiateCapabilities(input.requestedCapabilities);
    this.requestedCaps = this.capabilities;
    this.onSessionChange = input.onSessionChange;
    this.onConnected = input.onConnected;
    this.acked = input.presetAcked ?? false;
    this.port.onmessage = (e) => this.onMessage(e);
    this.port.start?.();
  }

  /** Set the live session and notify the host UI of the change. */
  private setSession(session: SdkSessionRecord | null): void {
    this.session = session;
    this.onSessionChange?.(session?.sid ?? null);
  }

  /** Account the session is bound to (chosen at connect, may differ from active). */
  getSessionAddress(): string | null {
    return this.sessionAddress;
  }

  /** Signing keys for the session account (set when a non-active account is used). */
  getSessionWallet(): Wallet | null {
    return this.sessionWallet;
  }

  /** Negotiated capabilities for this connection. */
  getCapabilities(): Capability[] {
    return this.capabilities;
  }

  /**
   * Adopt a port that was handed off from the connect popup. The dApp already
   * acked the original challenge, so we start already-acked, rebind the session
   * the popup minted, and keep the decrypted keys for the (possibly non-active)
   * session account so no PIN re-prompt is needed.
   */
  async adoptSession(session: SdkSessionRecord | null, wallet: Wallet | null): Promise<void> {
    this.acked = true;
    if (session) {
      this.session = session;
      this.sessionAddress = session.address;
      this.sessionWallet = wallet;
      // Keep the host's notion of the active session account coherent so reads
      // (getBalance) resolve for the connected account, not the wallet's active one.
      this.host.setSessionAccount(session.address);
      this.setSession(session);
    }
    // Tell the dApp the port now lives here. Any request it posted around the
    // transfer may have been dropped mid-flight; the client re-sends those
    // (same id/nonce) and they land on THIS handler with a fresh replay state.
    // Emitted even when no session could be restored so a lost request fails
    // with a clear UNAUTHORIZED instead of hanging the dApp.
    this.emitEvent(EVENTS.SESSION_ADOPTED, { sid: session?.sid ?? null });
  }

  /** The account address reads/signs should operate on for this session. */
  private currentAccount(): string | null {
    return this.sessionAddress ?? this.host.getAddress();
  }

  /** The signing keys to use for the session account. */
  private currentWallet(): Wallet | null {
    if (this.sessionAddress && this.sessionWallet) return this.sessionWallet;
    return this.host.getWallet();
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
    this.inFlight++;
    try {
      await this.dispatch(env, rawMethod, method);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * True while any request is being processed (approval shown, permission
   * grant in flight, signing, reply pending). The connect popup's handoff must
   * wait for this to clear: a reply posted on a port that was just transferred
   * is silently dropped and the dApp call hangs forever.
   */
  getInFlightCount(): number {
    return this.inFlight;
  }

  private async dispatch(env: Envelope, rawMethod: string, method: string): Promise<void> {
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

    // Locked-wallet gate: instead of failing outright, suspend the request and
    // ask the wallet UI to prompt for unlock. When the user unlocks, the promise
    // resolves true and we fall through to normal dispatch (approval/read/etc.).
    // If the user never unlocks, the dApp call times out on its own. DISCONNECT
    // is exempt so a dApp can always tear down a session without an unlock.
    if (method !== METHODS.DISCONNECT && !this.host.isUnlocked()) {
      const unlocked = await this.host.requestUnlock();
      if (!unlocked) {
        return this.fail(env.id, {
          code: ERROR_CODES.WALLET_LOCKED,
          message: 'Wallet is locked. Please unlock and try again.',
        });
      }
    }

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
        case METHODS.GET_NETWORK_INFO:
        case METHODS.GET_NETWORKS:
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
    // Lock is enforced by the centralized gate in handleRequest.

    // Session restore: a live session for this origin reconnects silently,
    // re-binding the account the user chose when the session was created.
    let session = await restoreSession(this.origin);

    // Otherwise, trusted sites skip ONLY the connect prompt.
    if (!session) {
      const trusted = await siteIsTrusted(this.origin);
      const accounts = this.host.getAccounts();
      // The picker is offered whenever the wallet holds more than one account —
      // the user should always be able to choose which account to connect.
      const decision: ApprovalDecision | null = trusted
        ? null
        : await this.host.requestApproval({
            kind: 'connect',
            origin: this.origin,
            detail: { capabilities: this.requestedCaps },
            accounts: accounts.length > 1 ? accounts : undefined,
          });
      const approved = trusted || (decision?.approved ?? false);
      if (!approved) {
        return this.fail(env.id, {
          code: ERROR_CODES.USER_REJECTED,
          message: 'User rejected the connection',
        });
      }
      if (decision?.trust) await trustSite(this.origin).catch(() => undefined);

      // The account the user chose via the picker in the approval UI (synced
      // through the host), falling back to the wallet's active account.
      const address =
        this.host.getSessionAccount() ?? this.host.getAddress() ?? accounts[0]?.address ?? '';
      this.sessionAddress = address;

      // Load signing keys for the session account. For the wallet's active
      // account this resolves immediately (already unlocked); any other account
      // requires the PIN and must not fail silently — the user picked it, so a
      // failed unlock rejects the connection.
      const wallet = await this.host.requestUnlockAccount(address);
      if (!wallet) {
        return this.fail(env.id, {
          code: ERROR_CODES.USER_REJECTED,
          message: 'Could not unlock the selected account',
        });
      }
      this.sessionWallet = wallet;

      session = await createSession({
        origin: this.origin,
        address,
        accounts: this.host.getAccounts().map((a) => a.address),
        network: this.host.getNetwork(),
        chainId: await this.host.getChainId(),
        permissions: DEFAULT_PERMISSIONS,
      });
    } else {
      // Silent reconnect: keep the account the previous session was bound to.
      const address = session.address;
      this.host.setSessionAccount(address);
      this.sessionAddress = address;
      const wallet = await this.host.requestUnlockAccount(address);
      this.sessionWallet = wallet ?? this.host.getWallet();
    }
    this.setSession(await touchSession(session));

    const address = this.currentAccount() ?? this.session!.address;
    const accounts = this.host.getAccounts();
    const pk = accounts.find((a) => a.address === address)?.publicKey ?? '';
    this.reply(env.id, {
      address,
      publicKey: pk,
      accounts,
      network: this.host.getNetwork(),
      networkInfo: this.host.getNetworkInfo(),
      chainId: await this.host.getChainId(),
      capabilities: this.capabilities,
      sessionId: this.session!.sid,
    });

    // Port is established and the connect response is sent — hand off to the
    // main wallet window so the session survives the popup closing.
    this.onConnected?.({
      sid: this.session!.sid,
      wallet: this.sessionWallet,
      address: this.sessionAddress,
      challenge: this.challenge,
      capabilities: this.capabilities,
    });
  }

  private async onDisconnect(env: Envelope): Promise<void> {
    await this.endCurrentSession('dApp requested');
    this.reply(env.id, { ok: true });
  }

  /**
   * End the live session and inform the dApp. Shared by the dApp-initiated
   * disconnect and the wallet-UI disconnect button so both stay in lockstep:
   * revoke the session, clear local state, and emit the disconnect event.
   */
  private async endCurrentSession(reason: string): Promise<void> {
    if (!this.session) return;
    await endSession(this.session.sid);
    this.setSession(null);
    this.sessionAddress = null;
    this.sessionWallet = null;
    this.emitEvent(EVENTS.DISCONNECT, { reason });
  }

  /** User pressed "Disconnect" inside the wallet popup. */
  async disconnectByUser(): Promise<void> {
    await this.endCurrentSession('user disconnected in wallet');
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
      this.setSession(null);
      this.fail(id, { code: ERROR_CODES.SESSION_EXPIRED, message: 'Session expired' });
      return null;
    }
    this.session = await touchSession(this.session);
    return this.session;
  }

  private async onRead(env: Envelope, method: string): Promise<void> {
    const session = await this.requireSession(env.id);
    if (!session) return;
    // Lock is enforced by the centralized gate in handleRequest.

    switch (method) {
      case METHODS.GET_ACCOUNTS:
        return this.reply(env.id, this.host.getAccounts());
      case METHODS.GET_ADDRESS:
        return this.reply(env.id, this.currentAccount());
      case METHODS.GET_PUBLIC_KEY: {
        const addr = this.currentAccount();
        const pk = this.host.getAccounts().find((a) => a.address === addr)?.publicKey ?? '';
        return this.reply(env.id, pk);
      }
      case METHODS.GET_BALANCE:
        return this.reply(env.id, await this.host.getBalance());
      case METHODS.GET_NETWORK:
        return this.reply(env.id, this.host.getNetwork());
      case METHODS.GET_NETWORK_INFO:
        return this.reply(env.id, this.host.getNetworkInfo());
      case METHODS.GET_NETWORKS:
        return this.reply(env.id, this.host.getNetworks());
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
    // Lock is enforced by the centralized gate in handleRequest; keep the
    // getWallet() null-guard below as defense in depth.
    const wallet = this.currentWallet();
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

    // A watch-only account holds no keys. Refuse before prompting: asking the
    // user to approve something that cannot succeed is worse than a clear error.
    if (isSigningScope && isWatchOnly(wallet)) {
      return this.fail(env.id, {
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'The active account is watch-only and cannot sign',
      });
    }

    switch (method) {
      case METHODS.SIGN_MESSAGE: {
        const raw = env.params as { message?: unknown; scheme?: unknown } | undefined;
        const message = String(raw?.message ?? '');
        // Only the two known schemes are honoured; anything else falls back to
        // the domain-separated default rather than silently signing raw bytes.
        const scheme: 'raw' | 'domain' = raw?.scheme === 'raw' ? 'raw' : 'domain';
        const decision = await this.host.requestApproval({
          kind: 'signMessage',
          origin: this.origin,
          // Surface the scheme so the approval UI can warn on untagged signing.
          detail: { message, scheme },
        });
        if (!decision.approved) return this.rejected(env.id);
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
        const decision = await this.host.requestApproval({
          kind: 'signTypedData',
          origin: this.origin,
          detail: { typedData: td as unknown as Record<string, unknown> },
        });
        if (!decision.approved) return this.rejected(env.id);
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
        const decision = await this.host.requestApproval({
          kind: 'approveContract',
          origin: this.origin,
          detail: { ...params },
        });
        if (!decision.approved) return this.rejected(env.id);
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
        // opType drives the payload ENCODING, not just a label, so an
        // unrecognised value must be refused rather than silently coerced —
        // signing under the wrong encoding produces a tx the node rejects,
        // and the signature cannot be repaired after the fact.
        if (
          params.opType !== undefined &&
          params.opType !== 'call' &&
          params.opType !== 'program_call'
        ) {
          return this.fail(env.id, {
            code: ERROR_CODES.INVALID_PARAMS,
            message: `signContract: unsupported opType "${String(params.opType)}" (expected "call" or "program_call")`,
          });
        }
        const decision = await this.host.requestApproval({
          kind: 'signContract',
          origin: this.origin,
          // Surface the resolved opType so the approval UI shows which
          // operation the user is actually authorising.
          detail: { ...params, opType: params.opType ?? 'program_call' },
        });
        if (!decision.approved) return this.rejected(env.id);
        this.session = await grantPermission(session, 'signContract');
        const nonce = await this.host.getNextNonce();
        const signed = signContractCall(wallet, { ...params, nonce });
        // Return the SIGNED tx only — never submitted here.
        return this.reply(env.id, {
          signedTransaction: signed.tx,
          program: signed.program,
          method: signed.method,
          opType: signed.opType,
          nonce,
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
