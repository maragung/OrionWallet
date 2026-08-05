/**
 * PopupTransport — opens the wallet's /connect popup, performs the security
 * handshake, and then communicates exclusively over a private MessageChannel
 * port.
 *
 * Communication discipline (enforced here):
 *   1. Exactly ONE window-level message is expected: the wallet's `hello`,
 *      which transfers a MessagePort. Its `event.origin` is validated against
 *      the wallet origin and its `rid` against the one we put in the URL.
 *   2. After that, ALL traffic is port-only. We stop listening to
 *      window 'message' events, so no other frame/window can inject.
 */
import {
  isEnvelope,
  makeId,
  type Capability,
  type Envelope,
  type HelloAck,
  type HelloMessage,
  negotiateVersion,
} from '../protocol';
import { popupBlocked, popupClosed, timeout, originMismatch, WalletError } from '../errors';
import { ERROR_CODES } from '../protocol';
import type {
  ConnectContext,
  HandshakeResult,
  Transport,
  TransportCloseHandler,
  TransportMessageHandler,
} from './types';

const DEFAULT_TIMEOUT = 60_000;
const POPUP_FEATURES = 'popup=yes,width=440,height=640,resizable=yes,scrollbars=yes';

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class PopupTransport implements Transport {
  private popup: Window | null = null;
  private port: MessagePort | null = null;
  private walletOrigin = '';
  private connected = false;
  private messageHandler: TransportMessageHandler | null = null;
  private closeHandler: TransportCloseHandler | null = null;
  private closeWatch: ReturnType<typeof setInterval> | null = null;

  connect(ctx: ConnectContext): Promise<HandshakeResult> {
    const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT;
    const walletUrl = new URL(ctx.walletUrl);
    this.walletOrigin = walletUrl.origin;

    const rid = makeId('rid');
    const dappNonce = randomToken();

    // Encode the handshake intent into the URL. The popup reads these to build
    // its hello. rid ties the hello back to THIS open() call.
    walletUrl.searchParams.set('v', '1');
    walletUrl.searchParams.set('rid', rid);
    walletUrl.searchParams.set('origin', location.origin);
    if (ctx.capabilities?.length) {
      walletUrl.searchParams.set('caps', ctx.capabilities.join(','));
    }

    // Must be called synchronously within a user gesture or browsers block it.
    const popup = window.open(walletUrl.toString(), 'octra-wallet-connect', POPUP_FEATURES);
    if (!popup) return Promise.reject(popupBlocked());
    this.popup = popup;

    return new Promise<HandshakeResult>((resolve, reject) => {
      let settled = false;
      const cleanupHello = () => window.removeEventListener('message', onHello);

      const fail = (err: WalletError) => {
        if (settled) return;
        settled = true;
        cleanupHello();
        this.stopCloseWatch();
        try {
          popup.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      const to = setTimeout(() => fail(timeout('Handshake timed out')), timeoutMs);

      // Detect the user closing the popup before the handshake completes.
      this.startCloseWatch(() => {
        if (!settled) fail(popupClosed());
      });

      const onHello = (ev: MessageEvent) => {
        // (1) Strict origin validation on the ONE window-level message.
        if (ev.origin !== this.walletOrigin) return;
        const data = ev.data as HelloMessage | undefined;
        if (!data || data.type !== 'octra-wallet:hello') return;
        if (data.rid !== rid) return; // not our handshake
        const port = ev.ports?.[0];
        if (!port) return fail(originMismatch('Wallet hello did not transfer a port'));

        const version = negotiateVersion(data.v);
        if (version === null) {
          return fail(new WalletError(ERROR_CODES.UNSUPPORTED, 'Incompatible wallet protocol'));
        }

        // (2) Switch to port-only. Stop window listening immediately.
        cleanupHello();
        clearTimeout(to);
        // The channel is now independent of the popup window, so stop treating a
        // closing popup as a disconnect.
        this.stopCloseWatch();
        this.port = port;
        port.onmessage = (e) => this.onPortMessage(e);
        port.start?.();

        // Echo the challenge over the PORT to prove we received the hello and
        // to open the session. Never echoed over window messaging.
        const ack: HelloAck = {
          challenge: data.challenge,
          dappNonce,
          v: version,
          origin: location.origin,
        };
        port.postMessage({ __ack: ack });

        this.connected = true;
        settled = true;
        resolve({
          version,
          capabilities: (data.capabilities ?? []) as Capability[],
          walletOrigin: this.walletOrigin,
        });
      };

      window.addEventListener('message', onHello);
    });
  }

  private onPortMessage(e: MessageEvent): void {
    const data = e.data;
    if (!isEnvelope(data)) return;
    this.messageHandler?.(data as Envelope);
  }

  send(env: Envelope): void {
    if (!this.port || !this.connected) {
      throw new WalletError(ERROR_CODES.INTERNAL, 'Transport is not connected');
    }
    this.port.postMessage(env);
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler;
  }

  onClose(handler: TransportCloseHandler): void {
    this.closeHandler = handler;
  }

  isConnected(): boolean {
    // Deliberately does NOT consult `popup.closed`.
    //
    // A MessagePort outlives the window that transferred it. Once the wallet has
    // handed the port over, the popup is free to close — the channel stays open
    // and the wallet keeps servicing requests from the /connect document.
    // Tying liveness to the popup meant every call after `connect()` failed with
    // "Transport is not connected" as soon as the approval window closed, which
    // is precisely the "connect works, nothing else does" symptom.
    return this.connected && !!this.port;
  }

  focus(): void {
    try {
      // Only meaningful while the approval window is still open. After it closes
      // the port keeps working, so there is nothing to focus and nothing to fix.
      if (this.popup && !this.popup.closed) this.popup.focus();
    } catch {
      /* ignore */
    }
  }

  close(reason = 'closed by dApp'): void {
    this.stopCloseWatch();
    if (this.port) {
      try {
        this.port.close();
      } catch {
        /* ignore */
      }
      this.port = null;
    }
    if (this.popup && !this.popup.closed) {
      try {
        this.popup.close();
      } catch {
        /* ignore */
      }
    }
    this.popup = null;
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.closeHandler?.(reason);
  }

  /**
   * Watch for the user dismissing the popup **during the handshake**.
   *
   * This only runs until the port is live. After that the popup closing is
   * normal and expected — the wallet closes it once the user has approved — and
   * must not tear down the session. `stopCloseWatch` is called as soon as the
   * hello arrives.
   */
  private startCloseWatch(onClosed: () => void): void {
    this.stopCloseWatch();
    this.closeWatch = setInterval(() => {
      // Once the port exists the channel is independent of the window.
      if (this.port) {
        this.stopCloseWatch();
        return;
      }
      if (this.popup && this.popup.closed) {
        this.stopCloseWatch();
        onClosed();
      }
    }, 400);
  }

  private stopCloseWatch(): void {
    if (this.closeWatch) {
      clearInterval(this.closeWatch);
      this.closeWatch = null;
    }
  }
}
