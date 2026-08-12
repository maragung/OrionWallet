/**
 * ConnectApp — the root rendered at the /connect route inside the wallet popup.
 *
 * Lifecycle:
 *   1. Parse handshake params (rid, origin, caps) from the URL.
 *   2. If the wallet is locked, render the unlock gate first.
 *   3. Once unlocked, send exactly ONE window-level message to the opener:
 *      the `hello`, transferring a MessagePort with a fresh random challenge.
 *      After this, all traffic is port-only via ConnectHandler.
 *   4. Render approval prompts on demand with auto-focus; resolve the
 *      handler's approval promises with the user's decision.
 *   5. Show active wallet info, account list, and network selector.
 *   6. Bridge same-origin wallet state changes (lock/unlock/account/network)
 *      into dApp-facing events via the live port.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { UnlockWallet } from '../components/UnlockWallet';
import { CreateWallet } from '../components/CreateWallet';
import { Toasts } from '../components/Toasts';
import { ThemeToggle } from '../components/ThemeToggle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useI18n } from '../i18n/useI18n';
import { EVENTS, WALLET_CAPABILITIES, type Capability, type HelloMessage } from '../sdk/protocol';
import { ConnectHandler, type ApprovalRequest, type WalletHost } from './rpc-handler';
import { ApprovalPrompt, type ApprovalDecision } from './approval-ui/ApprovalPrompt';
import { randomBytes } from '../crypto/random';
import { hexEncode } from '../crypto/hex';
import { listAccounts, unlockAccount } from '../api/wallet-api';
import { fetchNextNonce } from '../api/nonce';
import { PinModal } from '../components/PinModal';
import { patchSettings } from '../wallet/storage';
import { MAIN_WALLET_NAME, HANDOFF_TYPE } from './handoff';
import type { Wallet } from '../wallet/wallet';

interface HandshakeParams {
  rid: string;
  origin: string;
  caps: string[];
}

function parseParams(): HandshakeParams | null {
  const p = new URLSearchParams(location.search);
  const rid = p.get('rid');
  const origin = p.get('origin');
  if (!rid || !origin) return null;
  try {
    const u = new URL(origin);
    if (`${u.protocol}//${u.host}` !== origin) return null;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  const caps = (p.get('caps') ?? '').split(',').filter(Boolean);
  return { rid, origin, caps };
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

const NETWORK_OPTIONS = [
  { value: 'devnet' as const, label: 'Devnet', rpcUrl: 'https://devnet.octrascan.io/rpc' },
  { value: 'mainnet' as const, label: 'Mainnet', rpcUrl: 'https://mainnet.octrascan.io/rpc' },
];

function abbreviate(addr: string): string {
  if (addr.length <= 16) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export function ConnectApp() {
  const params = useMemo(parseParams, []);
  const store = useWalletStore();
  const { wallet, isUnlocked, rpc, initRpc, settings } = store;
  const { t } = useI18n();

  const [showCreate, setShowCreate] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [handshakeDone, setHandshakeDone] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [accounts, setAccounts] = useState<
    Array<{ address: string; publicKey: string; name?: string; index?: number }>
  >([]);
  const [balance, setBalance] = useState<{ balance: string; nonce: number } | null>(null);
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);
  // Whether the current connect approval shows the in-prompt account picker.
  const [accountPickerVisible, setAccountPickerVisible] = useState(false);
  // Account bound to the live session (may differ from the active wallet account).
  const [sessionAccount, setSessionAccountState] = useState<string | null>(null);
  // Signing keys for the session account when it differs from the active wallet.
  const sessionWalletRef = useRef<Wallet | null>(null);
  // PIN prompt for unlocking a non-active account for the session.
  const [pinRequest, setPinRequest] = useState<{
    addr: string;
    resolve: (w: Wallet | null) => void;
  } | null>(null);

  const handlerRef = useRef<ConnectHandler | null>(null);
  const helloSentRef = useRef(false);
  // Once the session has been handed off to the main wallet window, the popup
  // stops hosting it (and can close). Guards against double handoff.
  const handedOffRef = useRef(false);
  // Mirror of the active wallet address for callbacks (avoid stale closure).
  const walletAddrRef = useRef<string | null>(null);
  // Mirror of `selectedAddr` for use inside callbacks (avoid stale closure).
  const selectedAddrRef = useRef<string | null>(null);
  const pinRequestRef = useRef<{ addr: string; resolve: (w: Wallet | null) => void } | null>(
    null,
  );
  const pendingRef = useRef<PendingApproval | null>(null);
  // Account bound to the live session (mirror of `sessionAccount` state).
  const sessionAddrRef = useRef<string | null>(null);

  // Aggressively focus popup when approval prompt appears.
  // Browsers may ignore a single window.focus(), so we retry with delays.
  useEffect(() => {
    if (!pending) return;
    // Play a short beep to alert the user.
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      gain.gain.value = 0.15;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.stop(ctx.currentTime + 0.2);
    } catch {
      /* ignore */
    }
    const focusAttempts = [0, 100, 300, 600, 1000];
    const timers = focusAttempts.map((ms) =>
      setTimeout(() => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [pending]);

  // Load accounts once unlocked.
  const reloadAccounts = useCallback(() => {
    if (!isUnlocked) return;
    listAccounts()
      .then((list) =>
        setAccounts(
          list.map((a) => ({
            address: a.addr,
            publicKey: a.pubB64,
            name: a.name,
            index: a.index,
          })),
        ),
      )
      .catch(() => setAccounts([]));
  }, [isUnlocked]);

  useEffect(() => {
    reloadAccounts();
  }, [reloadAccounts]);

  // Sync selectedAddr when wallet changes.
  useEffect(() => {
    if (wallet?.addr) {
      walletAddrRef.current = wallet.addr;
      setSelectedAddr(wallet.addr);
      selectedAddrRef.current = wallet.addr;
    }
  }, [wallet?.addr]);

  // Keep the ref mirror in sync whenever selectedAddr changes.
  useEffect(() => {
    selectedAddrRef.current = selectedAddr;
  }, [selectedAddr]);

  // Keep the ref mirror in sync whenever pinRequest changes.
  useEffect(() => {
    pinRequestRef.current = pinRequest;
  }, [pinRequest]);

  // Keep the ref mirror in sync whenever pending changes (the handoff deferral
  // reads it outside of React).
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // Fetch balance for selected account.
  const displayAddr = selectedAddr || wallet?.addr;
  useEffect(() => {
    if (!rpc || !displayAddr) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    rpc
      .getBalance(displayAddr)
      .then((bi) => {
        if (cancelled) return;
        if (bi.ok && bi.result) {
          setBalance({ balance: bi.result.balance ?? '0', nonce: bi.result.nonce ?? 0 });
        }
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, displayAddr]);

  // Ensure RPC is available.
  useEffect(() => {
    if (isUnlocked && !rpc) initRpc().catch(() => undefined);
  }, [isUnlocked, rpc, initRpc]);

  const requestApproval = useCallback(
    (request: ApprovalRequest) =>
      new Promise<ApprovalDecision>((resolve) => {
        // Immediately focus the popup so the user sees the prompt.
        try {
          window.focus();
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            window.focus();
          } catch {
            /* ignore */
          }
        }, 200);
        setTimeout(() => {
          try {
            window.focus();
          } catch {
            /* ignore */
          }
        }, 500);
        const entry = {
          request,
          resolve: async (d: ApprovalDecision) => {
            setBusy(true);
            try {
              if (request.kind === 'connect' && d.approved) {
                // The account chosen in the prompt becomes the session account.
                sessionAddrRef.current = selectedAddrRef.current;
              }
            } finally {
              setBusy(false);
              setAccountPickerVisible(false);
              setPending(null);
              // Synchronous mirror: the handoff deferral reads this and must
              // not see a stale "no pending approval" while the prompt is live.
              pendingRef.current = null;
              resolve(d);
            }
          },
        };
        setPending(entry);
        // Synchronous mirror of the state above (see note in the resolve).
        pendingRef.current = entry;
        // Multi-account: show the in-prompt account picker so the user can
        // choose which account to connect.
        if (request.kind === 'connect' && (request.accounts?.length ?? 0) > 1) {
          // Default the picker to the active account.
          if (!selectedAddrRef.current) {
            setSelectedAddr(walletAddrRef.current);
            selectedAddrRef.current = walletAddrRef.current;
          }
          setAccountPickerVisible(true);
        }
      }),
    [],
  );

  // Requests that arrived while the wallet is locked park their resolvers here.
  // They all resolve together on the next lock→unlock transition, so multiple
  // concurrent requests share a single unlock prompt (coalescing).
  const unlockResolversRef = useRef<Array<(unlocked: boolean) => void>>([]);
  const requestUnlock = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        unlockResolversRef.current.push(resolve);
        // Alert + focus the popup so the user sees the unlock screen.
        try {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = 800;
          gain.gain.value = 0.15;
          osc.start();
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
          osc.stop(ctx.currentTime + 0.2);
        } catch {
          /* ignore */
        }
        [0, 200, 500].forEach((ms) =>
          setTimeout(() => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
          }, ms),
        );
      }),
    [],
  );

  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const host: WalletHost = useMemo(
    () => ({
      getWallet: () => useWalletStore.getState().wallet,
      isUnlocked: () => useWalletStore.getState().isUnlocked,
      getAddress: () => useWalletStore.getState().wallet?.addr ?? null,
      getAccounts: () => accountsRef.current,
      getNetwork: () => useWalletStore.getState().settings?.network ?? 'devnet',
      getChainId: async () => {
        const client = useWalletStore.getState().rpc;
        if (!client) return 'octra:unknown';
        const st = await client.getNodeStatus();
        return st.ok && st.result?.chain_id ? st.result.chain_id : 'octra:devnet';
      },
      getBalance: async () => {
        const s = useWalletStore.getState();
        const addr = sessionAddrRef.current ?? s.wallet?.addr;
        if (!s.rpc || !addr) return { balance: '0', balanceRaw: '0', nonce: 0 };
        const bi = await s.rpc.getBalance(addr);
        if (!bi.ok || !bi.result) return { balance: '0', balanceRaw: '0', nonce: 0 };
        return {
          balance: bi.result.balance ?? '0',
          balanceRaw: bi.result.balance_raw ?? '0',
          nonce: bi.result.nonce ?? 0,
        };
      },
      getNextNonce: async () => {
        const s = useWalletStore.getState();
        const addr = sessionAddrRef.current ?? s.wallet?.addr;
        if (!s.rpc || !addr) throw new Error('RPC unavailable');
        return fetchNextNonce(s.rpc, addr);
      },
      requestApproval,
      requestUnlock,
      requestUnlockAccount: async (addr: string) => {
        // The active wallet is already unlocked — reuse it directly.
        const active = useWalletStore.getState().wallet;
        if (active && active.addr === addr) return active;
        // Otherwise prompt for the PIN to decrypt the account's keys.
        return new Promise<Wallet | null>((resolve) => {
          setPinRequest({ addr, resolve });
          // Synchronous mirror: the handoff deferral reads this.
          pinRequestRef.current = { addr, resolve };
        });
      },
      setSessionAccount: (addr) => {
        sessionAddrRef.current = addr;
        setSessionAccountState(addr);
        setSelectedAddr(addr);
        selectedAddrRef.current = addr;
      },
      getSessionAccount: () => sessionAddrRef.current,
    }),
    [requestApproval, requestUnlock],
  );

  // ── PIN gate for unlocking a non-active session account ───────────────────
  const handlePinSubmit = useCallback(async (pin: string) => {
    const req = pinRequestRef.current;
    if (!req) return;
    const w = await unlockAccount(req.addr, pin); // throws on wrong PIN
    // Hold the decrypted keys for the session; do NOT change the active wallet.
    sessionWalletRef.current = w;
    req.resolve(w);
    setPinRequest(null);
    pinRequestRef.current = null;
  }, []);

  const handlePinSubmitSafe = useCallback(
    async (pin: string) => {
      try {
        await handlePinSubmit(pin);
      } catch (e) {
        console.error('[connect] unlock account failed:', e);
        throw e;
      }
    },
    [handlePinSubmit],
  );

  const handlePinCancel = useCallback(() => {
    const req = pinRequestRef.current;
    if (!req) return;
    req.resolve(null);
    setPinRequest(null);
    pinRequestRef.current = null;
  }, []);

  /**
   * Hand the wallet-side port off to the long-lived main wallet window so the
   * session keeps working after this popup closes. No-ops (and leaves the popup
   * hosting) when the main wallet window isn't open.
   */
  const maybeHandoff = useCallback(
    (channel: MessageChannel, challenge: string) => {
      if (handedOffRef.current) return;
      const h = handlerRef.current;
      if (!h) return;
      // Skip unless the main wallet window is actually open (see main.tsx). This
      // avoids opening a stray blank window when it isn't.
      let mainOpen = false;
      try {
        mainOpen = localStorage.getItem('orion:main-wallet-open') === '1';
      } catch {
        /* ignore — treat as not open, handoff falls back to popup hosting */
      }
      if (!mainOpen) return; // keep hosting in the popup
      // Never transfer the port while an approval or PIN prompt is on screen,
      // or while ANY request is still being processed (approval clicked but the
      // reply not yet posted): the pending promise would resolve after the
      // transfer and post its reply on a port that no longer belongs to this
      // window — the dApp call would hang forever. Retry until the popup is idle.
      if (
        pendingRef.current ||
        pinRequestRef.current ||
        h.getInFlightCount() > 0
      ) {
        console.log('[handoff] deferring, pending=', !!pendingRef.current, 'pin=', !!pinRequestRef.current, 'inflight=', h.getInFlightCount());
        setTimeout(() => maybeHandoff(channel, challenge), 100);
        return;
      }
      // The main wallet window shares this origin; reach it by its stable name.
      const main = window.open('', MAIN_WALLET_NAME);
      console.log('[handoff] main window lookup:',
        main === null ? 'null' : main === window ? 'self' : 'found');
      if (!main || main === window) return; // not found — keep hosting in the popup
      // Safety net: if we accidentally got a blank window, close it and fall back.
      try {
        if (main.location.href === 'about:blank') {
          console.log('[handoff] got blank window, closing + fallback');
          main.close();
          return;
        }
      } catch {
        /* cross-origin read blocked — treat as the real main window */
      }
      // Re-check after the lookup: a request may have arrived (and prompted)
      // while we were resolving the window. Transferring now would strand its
      // reply. Retry instead.
      if (
        pendingRef.current ||
        pinRequestRef.current ||
        h.getInFlightCount() > 0
      ) {
        console.log('[handoff] deferring after lookup, pending=', !!pendingRef.current, 'pin=', !!pinRequestRef.current, 'inflight=', h.getInFlightCount());
        setTimeout(() => maybeHandoff(channel, challenge), 100);
        return;
      }
      handedOffRef.current = true;
      console.log('[handoff] transferring port');
      const info = {
        type: HANDOFF_TYPE,
        origin: params!.origin,
        challenge,
        caps: h.getCapabilities() as string[],
        // Cloned (same-origin) so the session account's keys survive without a
        // re-PIN prompt. The popup's copy is dropped when it closes.
        wallet: h.getSessionWallet() as unknown,
        address: h.getSessionAddress(),
      };
      try {
        main.postMessage(info, location.origin, [channel.port1]);
        store.pushToast('success', 'Connected — session now managed by your wallet');
      } catch (e) {
        // Transfer failed; fall back to hosting in the popup.
        console.error('[handoff] transfer failed, keeping popup hosting:', e);
        handedOffRef.current = false;
        return;
      }
      // Give the main window a moment to adopt, then close the popup. If the
      // browser blocks script-close, the popup simply stays (non-functional,
      // but the session already lives in the main window).
      setTimeout(() => {
        try {
          window.close();
        } catch {
          /* ignore */
        }
      }, 400);
    },
    [params, store],
  );

  // Send hello + wire the handler, exactly once, after unlock.
  useEffect(() => {
    if (!params || !isUnlocked || helloSentRef.current) return;
    const opener = window.opener as Window | null;
    if (!opener) return;

    helloSentRef.current = true;

    const channel = new MessageChannel();
    const challenge = hexEncode(randomBytes(32));

    handlerRef.current = new ConnectHandler({
      host,
      port: channel.port1,
      origin: params.origin,
      challenge,
      requestedCapabilities: params.caps.length ? params.caps : (WALLET_CAPABILITIES as string[]),
      onSessionChange: (sid) => setSessionId(sid),
      onConnected: () => {
        // The port is established and the connect response has been sent. Hand
        // the wallet-side port to the long-lived main wallet window so the
        // session survives this popup closing. Deferred slightly so the connect
        // reply is delivered before the port changes owner.
        setTimeout(() => maybeHandoff(channel, challenge), 150);
      },
    });

    const hello: HelloMessage = {
      type: 'octra-wallet:hello',
      v: 1,
      rid: params.rid,
      challenge,
      capabilities: (params.caps.length
        ? WALLET_CAPABILITIES.filter((c) => params.caps.includes(c))
        : WALLET_CAPABILITIES) as Capability[],
      walletOrigin: location.origin,
    };

    opener.postMessage(hello, params.origin, [channel.port2]);
    setHandshakeDone(true);
  }, [params, isUnlocked, host, maybeHandoff]);

  // Bridge wallet lock/unlock into dApp events.
  const prevUnlocked = useRef(isUnlocked);
  useEffect(() => {
    const h = handlerRef.current;
    if (!h) {
      prevUnlocked.current = isUnlocked;
      return;
    }
    if (prevUnlocked.current && !isUnlocked) h.emitEvent(EVENTS.WALLET_LOCKED, {});
    if (!prevUnlocked.current && isUnlocked) {
      h.emitEvent(EVENTS.WALLET_UNLOCKED, {});
      // Resolve all suspended requests that were waiting for unlock.
      const resolvers = unlockResolversRef.current;
      unlockResolversRef.current = [];
      resolvers.forEach((r) => r(true));
    }
    prevUnlocked.current = isUnlocked;
  }, [isUnlocked]);

  // ── Network switcher ────────────────────────────────────────────────────
  const handleSwitchNetwork = useCallback(
    async (net: 'devnet' | 'mainnet') => {
      if (net === settings?.network) return;
      const opt = NETWORK_OPTIONS.find((n) => n.value === net);
      if (!opt) return;
      const updated = await patchSettings({ network: net, rpcUrl: opt.rpcUrl });
      store.setSettings(updated);
      store.initRpc().catch(() => undefined);
      handlerRef.current?.emitEvent(EVENTS.NETWORK_CHANGED, {
        network: net,
        chainId: `octra:${net}`,
      });
    },
    [settings?.network, store],
  );

  // ── Disconnect (user-initiated from the popup) ──────────────────────────
  const handleDisconnect = useCallback(async () => {
    setShowDisconnectConfirm(false);
    const h = handlerRef.current;
    if (h) await h.disconnectByUser();
    store.pushToast('success', t('connect.disconnected'));
    setTimeout(() => {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    }, 500);
  }, [store, t]);

  // ── Render ──────────────────────────────────────────────────────────────

  if (!params) {
    return (
      <div style={pageStyle}>
        <div className="card" style={{ maxWidth: 420 }}>
          <div className="card-title">Invalid connection request</div>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
            This page must be opened by a dApp through the Octra Wallet SDK.
          </p>
        </div>
      </div>
    );
  }

  if (!isUnlocked || !wallet) {
    return (
      <div style={pageStyle}>
        {showCreate ? (
          <CreateWallet onBack={() => setShowCreate(false)} />
        ) : (
          <UnlockWallet onCreate={() => setShowCreate(true)} />
        )}
        <Toasts />
      </div>
    );
  }

  const activeNetwork = settings?.network ?? 'devnet';

  const selectStyle: React.CSSProperties = {};

  return (
    <div style={pageStyle}>
      {/* Top bar: dropdowns + theme toggle */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        {accounts.length > 1 && !accountPickerVisible && (
          <select
            value={displayAddr}
            onChange={(e) => setSelectedAddr(e.target.value)}
            className="connect-select connect-select-account"
            title="Select account"
          >
            {accounts.map((a) => (
              <option key={a.address} value={a.address}>
                {a.name || `Account ${a.index ?? 0}`} ({abbreviate(a.address)})
              </option>
            ))}
          </select>
        )}
        <select
          value={activeNetwork}
          onChange={(e) => handleSwitchNetwork(e.target.value as 'devnet' | 'mainnet')}
          className="connect-select"
          style={selectStyle}
          title="Network"
        >
          {NETWORK_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ThemeToggle />
      </div>

      {pending ? (
        <div style={overlayStyle}>
          <ApprovalPrompt
            request={pending.request}
            onDecision={pending.resolve}
            busy={busy}
            accounts={pending.request.accounts}
            selectedAccount={selectedAddr}
            onSelectAccount={(addr) => {
              setSelectedAddr(addr);
              selectedAddrRef.current = addr;
            }}
          />
        </div>
      ) : (
        <div style={{ maxWidth: 420, width: '100%' }}>
          {/* Connected header */}
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="card-title" style={{ justifyContent: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>&#128279;</span>
              {handshakeDone ? 'Connected' : 'Establishing secure channel\u2026'}
            </div>
            <p
              className="mono"
              style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', margin: '4px 0 0' }}
            >
              {params.origin}
            </p>
            <button
              onClick={() => setShowDisconnectConfirm(true)}
              className="ghost"
              style={{ marginTop: 12, width: '100%' }}
              disabled={!sessionId}
            >
              {t('connect.disconnect')}
            </button>
          </div>

          {/* Active wallet info */}
          <div className="card">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <strong style={{ fontSize: 'var(--fs-sm)' }}>
                {sessionAccount && sessionAccount !== wallet?.addr
                  ? 'Session Account'
                  : 'Active Wallet'}
              </strong>
              <span className="pill ok" style={{ fontSize: 11 }}>
                unlocked
              </span>
            </div>
            <div
              className="mono"
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                wordBreak: 'break-all',
              }}
            >
              {displayAddr}
            </div>
            {sessionAccount && sessionAccount !== wallet?.addr && (
              <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                Connected with a different account than your active wallet (
                {wallet?.addr.slice(0, 8)}…). Your wallet account is unchanged.
              </div>
            )}
            {balance && (
              <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>
                Balance: <strong>{balance.balance}</strong> OCT
                <span style={{ marginLeft: 12, color: 'var(--text-muted)' }}>
                  nonce: {balance.nonce}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={showDisconnectConfirm}
        title={t('connect.disconnectTitle')}
        message={t('connect.disconnectMessage')}
        confirmLabel={t('connect.disconnect')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={handleDisconnect}
        onCancel={() => setShowDisconnectConfirm(false)}
      />
      <PinModal
        open={pinRequest !== null}
        title="Unlock account"
        description={
          pinRequest
            ? `Enter your PIN to unlock ${accounts.find((a) => a.address === pinRequest.addr)?.name || 'this account'} for this connection. ` +
              'Your active wallet account stays unchanged.'
            : undefined
        }
        confirmLabel="Unlock"
        busyLabel="Unlocking…"
        onSubmit={handlePinSubmitSafe}
        onCancel={handlePinCancel}
      />
      <Toasts />
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  // dvh fallback: iOS Safari's 100vh includes the dynamic toolbar, so the
  // connect popup could overflow. Matches UnlockWallet / CreateWallet.
  ...({ minHeight: '100dvh' } as React.CSSProperties),
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--sp-4)',
  position: 'relative',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2000,
  padding: 'var(--sp-4)',
};
