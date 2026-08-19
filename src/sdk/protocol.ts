/**
 * Shared wire protocol for the Octra Wallet SDK.
 *
 * This module is imported by BOTH sides of the channel:
 *   - the dApp-side SDK (`src/sdk/*`)
 *   - the wallet-side connect popup (`src/connect/*`)
 *
 * It MUST stay free of any React, wallet-core, or DOM-heavy imports so the
 * dApp bundle can tree-shake it down to just the constants and validators it
 * uses. Only pure data + pure functions live here.
 */

/** Bump when the envelope shape or handshake semantics change incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Lowest protocol version this build can still talk to. */
export const MIN_PROTOCOL_VERSION = 1;

/**
 * Methods the provider is allowed to expose. Reads are answered from the
 * wallet's session silently; signs always open an approval popup.
 */
export const METHODS = {
  // Connection / session
  CONNECT: 'wallet_connect',
  DISCONNECT: 'wallet_disconnect',
  /**
   * Liveness check. Answers `{ pong: true, … }` without touching the wallet's
   * state, opening a popup, or asking the user anything.
   *
   * It exists because the alternative is worse. A dApp that wants to know
   * whether its session is still answered has otherwise only one option:
   * re-issue `wallet_connect`. That re-runs permission negotiation, can surface
   * a fresh approval prompt, and mutates the very session it was trying to
   * observe — so the probe itself is what breaks the thing being probed. A
   * dedicated no-op read makes the question answerable without side effects.
   */
  PING: 'wallet_ping',
  // Read-only wallet information (session-silent)
  GET_ACCOUNTS: 'wallet_getAccounts',
  GET_ADDRESS: 'wallet_getAddress',
  GET_PUBLIC_KEY: 'wallet_getPublicKey',
  GET_BALANCE: 'wallet_getBalance',
  GET_NETWORK: 'wallet_getNetwork',
  /** Active network as a structured record (id, name, explorer, custom flag). */
  GET_NETWORK_INFO: 'wallet_getNetworkInfo',
  /** Every network the wallet offers, including ones the user added by hand. */
  GET_NETWORKS: 'wallet_getNetworks',
  GET_CHAIN_ID: 'wallet_getChainId',
  GET_PERMISSIONS: 'wallet_getPermissions',
  // Signing (always require explicit user confirmation)
  SIGN_MESSAGE: 'wallet_signMessage',
  SIGN_TYPED_DATA: 'wallet_signTypedData',
  APPROVE_CONTRACT: 'wallet_approveContract',
  SIGN_CONTRACT: 'wallet_signContract',
  /**
   * Sign a plain native-token transfer (`op_type: 'standard'`).
   *
   * SIGN-ONLY, like every other method here: the wallet returns a signed
   * transaction and never submits it. Broadcasting stays the caller's job, and
   * `wallet_sendTransaction` remains permanently prohibited — see
   * PROHIBITED_METHODS.
   *
   * Without this, a dApp that needs a signed transfer has to disguise it as a
   * contract call and then rewrite `op_type` on the result. That does not work:
   * `op_type` is inside the canonical JSON that was signed (see
   * `src/tx/canonical-json.ts`), so editing it afterwards invalidates the
   * signature — and the approval prompt meanwhile describes a contract call the
   * user is not actually making. Both problems are the missing method, not the
   * dApp.
   */
  SIGN_TRANSFER: 'wallet_signTransfer',
} as const;

export type Method = (typeof METHODS)[keyof typeof METHODS];

/**
 * Orion-branded method namespace.
 *
 * `orion_wallet_*` is an alias for the corresponding `wallet_*` method. Both are
 * accepted by the wallet; they are the same operation and carry the same
 * security requirements. The generic `wallet_*` names remain supported so that
 * existing dApp integrations keep working.
 *
 * Example: `orion_wallet_signMessage` === `wallet_signMessage`.
 */
export const ORION_METHOD_PREFIX = 'orion_wallet_';
const GENERIC_METHOD_PREFIX = 'wallet_';

/** `orion_wallet_*` equivalents of every entry in METHODS. */
export const ORION_METHODS = Object.fromEntries(
  Object.entries(METHODS).map(([key, value]) => [
    key,
    value.replace(GENERIC_METHOD_PREFIX, ORION_METHOD_PREFIX),
  ]),
) as { [K in keyof typeof METHODS]: string };

/** Every method name the wallet answers to, in either namespace. */
export const SUPPORTED_METHODS: readonly string[] = [
  ...Object.values(METHODS),
  ...Object.values(ORION_METHODS),
];

/**
 * Reduce a method name to its canonical `wallet_*` form.
 *
 * The dispatcher matches on canonical names only, so an alias can never drift
 * out of sync with the method it stands for. Unknown names pass through
 * unchanged and are rejected downstream as METHOD_NOT_FOUND.
 */
export function canonicalizeMethod(method: string): string {
  if (typeof method !== 'string') return '';
  const trimmed = method.trim();
  return trimmed.startsWith(ORION_METHOD_PREFIX)
    ? GENERIC_METHOD_PREFIX + trimmed.slice(ORION_METHOD_PREFIX.length)
    : trimmed;
}

/**
 * Methods that are PERMANENTLY prohibited. The SDK never exposes these, and
 * the wallet-side dispatcher rejects them with METHOD_FORBIDDEN even when
 * requested through the low-level `request()` escape hatch. This is the
 * structural guarantee that no blockchain transaction can be broadcast, moved,
 * swapped, or bridged through the SDK — all execution stays in the wallet UI.
 */
export const PROHIBITED_METHODS: readonly string[] = [
  'wallet_sendTransaction',
  'sendTransaction',
  'wallet_broadcastTransaction',
  'broadcastTransaction',
  'wallet_transfer',
  'transfer',
  'wallet_swap',
  'swap',
  'wallet_bridge',
  'bridge',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
] as const;

/** Case-insensitive prohibited-method check (also catches substring intents). */
export function isProhibitedMethod(method: string): boolean {
  const m = method.trim().toLowerCase();
  if (PROHIBITED_METHODS.some((p) => p.toLowerCase() === m)) return true;
  // Defence in depth: reject anything that clearly intends execution.
  return /(sendtransaction|broadcast|(^|_)transfer$|(^|_)swap$|(^|_)bridge$)/.test(m);
}

/** Capabilities negotiated during the hello handshake. */
export const CAPABILITIES = {
  SIGN_MESSAGE: 'signMessage',
  SIGN_TYPED_DATA: 'signTypedData',
  APPROVE_CONTRACT: 'approveContract',
  SIGN_CONTRACT: 'signContract',
  /** `wallet_signTransfer` is available (native transfers need no disguise). */
  SIGN_TRANSFER: 'signTransfer',
  /** `wallet_ping` is available (liveness without re-running connect). */
  PING: 'ping',
  MULTI_ACCOUNT: 'multiAccount',
  EVENTS: 'events',
  SESSION_RESTORE: 'sessionRestore',
  /**
   * The wallet can describe its networks — `wallet_getNetworkInfo` /
   * `wallet_getNetworks` answer, and `networkChanged` carries a `networkInfo`
   * payload. dApps feature-detect on this before relying on either; older
   * wallet builds only expose the bare `wallet_getNetwork` id string.
   */
  CUSTOM_NETWORKS: 'customNetworks',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** Capabilities this wallet build advertises. */
export const WALLET_CAPABILITIES: Capability[] = [
  CAPABILITIES.SIGN_MESSAGE,
  CAPABILITIES.SIGN_TYPED_DATA,
  CAPABILITIES.APPROVE_CONTRACT,
  CAPABILITIES.SIGN_CONTRACT,
  CAPABILITIES.SIGN_TRANSFER,
  CAPABILITIES.PING,
  CAPABILITIES.MULTI_ACCOUNT,
  CAPABILITIES.EVENTS,
  CAPABILITIES.SESSION_RESTORE,
  CAPABILITIES.CUSTOM_NETWORKS,
];

/** Events the wallet can push to a connected dApp. */
export const EVENTS = {
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  ACCOUNT_CHANGED: 'accountChanged',
  NETWORK_CHANGED: 'networkChanged',
  SESSION_EXPIRED: 'sessionExpired',
  WALLET_LOCKED: 'walletLocked',
  WALLET_UNLOCKED: 'walletUnlocked',
  PERMISSION_CHANGED: 'permissionChanged',
  /** The connect popup handed the session port over to the main wallet window.
   * Requests that were in flight before this event may have been lost in the
   * transfer; clients must re-send them (same id/nonce). */
  SESSION_ADOPTED: 'sessionAdopted',
} as const;

export type WalletEventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Stable machine-readable error codes carried on the wire. */
export const ERROR_CODES = {
  USER_REJECTED: 'USER_REJECTED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  METHOD_FORBIDDEN: 'METHOD_FORBIDDEN',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  WALLET_LOCKED: 'WALLET_LOCKED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ORIGIN_MISMATCH: 'ORIGIN_MISMATCH',
  CHALLENGE_FAILED: 'CHALLENGE_FAILED',
  REPLAY_DETECTED: 'REPLAY_DETECTED',
  UNSUPPORTED: 'UNSUPPORTED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TIMEOUT: 'TIMEOUT',
  POPUP_BLOCKED: 'POPUP_BLOCKED',
  POPUP_CLOSED: 'POPUP_CLOSED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Discriminant for envelope direction. */
export type EnvelopeKind = 'req' | 'res' | 'evt';

/** Error payload carried inside a response envelope. */
export interface WireError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

/**
 * The single message shape that travels over the MessageChannel port.
 * `nonce` and `ts` power replay protection; `id` correlates req↔res.
 */
export interface Envelope<P = unknown, R = unknown> {
  /** Protocol version of the sender. */
  v: number;
  /** Correlation id (uuid-like). For events, a fresh id each time. */
  id: string;
  kind: EnvelopeKind;
  /** Present on requests. */
  method?: string;
  /** Request params / event payload. */
  params?: P;
  /** Present on successful responses. */
  result?: R;
  /** Present on failed responses. */
  error?: WireError;
  /** Event name (present when kind === 'evt'). */
  event?: WalletEventName;
  /** Monotonic per-session counter for replay protection. */
  nonce: number;
  /** Sender wall-clock time (ms epoch) for freshness checks. */
  ts: number;
}

/** Payload of the wallet→dApp bootstrap message (the ONLY window-level msg). */
export interface HelloMessage {
  type: 'octra-wallet:hello';
  /** Protocol version offered by the wallet. */
  v: number;
  /** Request id echoed from the popup URL, ties hello to this open() call. */
  rid: string;
  /** Random challenge the dApp must echo back over the port. */
  challenge: string;
  /** Capabilities the wallet advertises. */
  capabilities: Capability[];
  /** Wallet origin, for the dApp to cross-check against event.origin. */
  walletOrigin: string;
}

/** dApp→wallet first port message: echoes the challenge, opens the session. */
export interface HelloAck {
  /** Must equal HelloMessage.challenge or the wallet aborts. */
  challenge: string;
  /** dApp's own random nonce seed, mixed into replay state. */
  dappNonce: string;
  /** Protocol version the dApp will speak (<= wallet's). */
  v: number;
  /** dApp origin as the dApp sees itself (defence-in-depth cross-check). */
  origin: string;
}

let idCounter = 0;

/**
 * Generate a reasonably-unique correlation id without pulling in a uuid dep.
 *
 * SECURITY: this is for message correlation ONLY and must never be used as a
 * security value. The `Math.random` fallback is not cryptographically secure.
 * Anti-replay challenges and nonces are generated with `randomBytes` (WebCrypto)
 * in ConnectApp and PopupTransport — keep it that way.
 */
export function makeId(prefix = 'r'): string {
  idCounter = (idCounter + 1) & 0xffffff;
  const rand =
    typeof crypto !== 'undefined' && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint32Array(2))
      : [Math.floor(Math.random() * 2 ** 32), Math.floor(Math.random() * 2 ** 32)];
  return `${prefix}_${Date.now().toString(36)}_${rand[0]!.toString(36)}${rand[1]!.toString(36)}_${idCounter.toString(36)}`;
}

/** Negotiate the highest protocol version both sides support. */
export function negotiateVersion(theirs: number): number | null {
  if (!Number.isInteger(theirs) || theirs < MIN_PROTOCOL_VERSION) return null;
  return Math.min(theirs, PROTOCOL_VERSION);
}

/** Intersect wallet capabilities with what a dApp asks for (or all if none). */
export function negotiateCapabilities(requested?: string[]): Capability[] {
  if (!requested || requested.length === 0) return [...WALLET_CAPABILITIES];
  const set = new Set(requested);
  return WALLET_CAPABILITIES.filter((c) => set.has(c));
}

/** Type guard + structural validation for an inbound envelope. */
export function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.id === 'string' &&
    (e.kind === 'req' || e.kind === 'res' || e.kind === 'evt') &&
    typeof e.nonce === 'number' &&
    typeof e.ts === 'number'
  );
}

/** Build a request envelope. */
export function makeRequest<P>(method: string, params: P, nonce: number): Envelope<P> {
  return {
    v: PROTOCOL_VERSION,
    id: makeId('req'),
    kind: 'req',
    method,
    params,
    nonce,
    ts: Date.now(),
  };
}

/** Build a success response envelope correlated to a request id. */
export function makeResponse<R>(id: string, result: R, nonce: number): Envelope<never, R> {
  return { v: PROTOCOL_VERSION, id, kind: 'res', result, nonce, ts: Date.now() };
}

/** Build an error response envelope correlated to a request id. */
export function makeError(id: string, error: WireError, nonce: number): Envelope {
  return { v: PROTOCOL_VERSION, id, kind: 'res', error, nonce, ts: Date.now() };
}

/** Build an event envelope. */
export function makeEvent<P>(event: WalletEventName, params: P, nonce: number): Envelope<P> {
  return {
    v: PROTOCOL_VERSION,
    id: makeId('evt'),
    kind: 'evt',
    event,
    params,
    nonce,
    ts: Date.now(),
  };
}
