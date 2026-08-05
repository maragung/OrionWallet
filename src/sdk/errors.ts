/**
 * Typed error classes for the SDK. Kept dependency-free so both the dApp SDK
 * and the wallet-side handler can throw/serialize them uniformly.
 */
import { ERROR_CODES, type ErrorCode, type WireError } from './protocol';

/** Error thrown across the SDK; carries a stable machine-readable code. */
export class WalletError extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    this.data = data;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, WalletError.prototype);
  }

  /** Serialize to the on-wire error payload. */
  toWire(): WireError {
    return { code: this.code, message: this.message, data: this.data };
  }

  /** Reconstruct from an on-wire error payload. */
  static fromWire(e: WireError): WalletError {
    return new WalletError(e.code, e.message, e.data);
  }
}

export const userRejected = (msg = 'User rejected the request'): WalletError =>
  new WalletError(ERROR_CODES.USER_REJECTED, msg);

export const unauthorized = (msg = 'Not authorized for this origin'): WalletError =>
  new WalletError(ERROR_CODES.UNAUTHORIZED, msg);

export const methodForbidden = (method: string): WalletError =>
  new WalletError(
    ERROR_CODES.METHOD_FORBIDDEN,
    `Method "${method}" is prohibited by the wallet SDK. Transaction execution ` +
      `(send, broadcast, transfer, swap, bridge) is only available inside the wallet UI.`,
  );

export const walletLocked = (msg = 'Wallet is locked'): WalletError =>
  new WalletError(ERROR_CODES.WALLET_LOCKED, msg);

export const sessionExpired = (msg = 'Session expired'): WalletError =>
  new WalletError(ERROR_CODES.SESSION_EXPIRED, msg);

export const originMismatch = (msg = 'Origin mismatch'): WalletError =>
  new WalletError(ERROR_CODES.ORIGIN_MISMATCH, msg);

export const replayDetected = (msg = 'Replay or stale message detected'): WalletError =>
  new WalletError(ERROR_CODES.REPLAY_DETECTED, msg);

export const timeout = (msg = 'Request timed out'): WalletError =>
  new WalletError(ERROR_CODES.TIMEOUT, msg);

export const popupBlocked = (
  msg = 'Wallet popup was blocked. Call connect() from a user gesture (click).',
): WalletError => new WalletError(ERROR_CODES.POPUP_BLOCKED, msg);

export const popupClosed = (msg = 'Wallet popup was closed before completing'): WalletError =>
  new WalletError(ERROR_CODES.POPUP_CLOSED, msg);

export const invalidParams = (msg: string): WalletError =>
  new WalletError(ERROR_CODES.INVALID_PARAMS, msg);
