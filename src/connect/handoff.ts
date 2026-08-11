/**
 * Constants + message shape for handing a live connect session's wallet-side
 * port from the (short-lived) /connect popup to the long-lived main wallet
 * window, so the dApp session survives the popup closing.
 *
 * Both documents are same-origin (the wallet app), so the popup can reach the
 * main window via its stable `window.name` and transfer the port.
 */

/** Stable name assigned to the main wallet window so the popup can find it. */
export const MAIN_WALLET_NAME = 'orion-wallet-main';

/** Message type posted from the /connect popup to the main wallet window. */
export const HANDOFF_TYPE = 'octra-wallet:connect-handoff';

export interface ConnectHandoffMessage {
  type: typeof HANDOFF_TYPE;
  /** dApp origin the session is bound to. */
  origin: string;
  /** Challenge the dApp already acked (main handler starts pre-acked). */
  challenge: string;
  /** Negotiated capabilities. */
  caps: string[];
  /** Cloned decrypted wallet for the (possibly non-active) session account. */
  wallet: unknown | null;
  /** Address the session is bound to. */
  address: string | null;
}
