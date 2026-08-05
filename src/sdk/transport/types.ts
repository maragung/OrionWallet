/**
 * Transport abstraction.
 *
 * The provider talks to the wallet through a `Transport`, never directly to a
 * popup/port. This is the seam that lets future transports (relay iframe,
 * browser-extension bridge, etc.) drop in without touching provider logic.
 */
import type { Envelope } from '../protocol';

/** A message received from the wallet side (already JSON-parsed). */
export type TransportMessageHandler = (env: Envelope) => void;

/** Notified when the underlying channel goes away (popup closed, etc.). */
export type TransportCloseHandler = (reason: string) => void;

export interface ConnectContext {
  /** Wallet connect URL, e.g. "https://wallet.app/connect". */
  walletUrl: string;
  /** Capabilities the dApp wants (subset negotiated by the wallet). */
  capabilities?: string[];
  /** Handshake timeout in ms. */
  timeoutMs?: number;
}

/** Result of a completed handshake. */
export interface HandshakeResult {
  /** Negotiated protocol version. */
  version: number;
  /** Capabilities granted by the wallet. */
  capabilities: string[];
  /** Wallet origin (validated). */
  walletOrigin: string;
}

/**
 * A bidirectional, ordered, origin-validated message channel to the wallet.
 * After `connect()` resolves, all traffic flows through `send`/`onMessage`
 * over a private MessageChannel port — no window-level messaging.
 */
export interface Transport {
  /** Open the channel and complete the security handshake. */
  connect(ctx: ConnectContext): Promise<HandshakeResult>;
  /** Send an envelope to the wallet. Throws if not connected. */
  send(env: Envelope): void;
  /** Register the single inbound-message handler. */
  onMessage(handler: TransportMessageHandler): void;
  /** Register a channel-closed handler. */
  onClose(handler: TransportCloseHandler): void;
  /** Whether the channel is currently open. */
  isConnected(): boolean;
  /** Tear down the channel and release resources. */
  close(reason?: string): void;
  /** Bring the wallet UI to the foreground (best-effort). */
  focus(): void;
}
