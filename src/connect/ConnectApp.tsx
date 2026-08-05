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
import { trustSite } from './trusted-sites';
import { randomBytes } from '../crypto/random';
import { hexEncode } from '../crypto/hex';
import { listAccounts } from '../api/wallet-api';
import { patchSettings } from '../wallet/storage';

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

  const handlerRef = useRef<ConnectHandler | null>(null);
  const helloSentRef = useRef(false);

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
    if (wallet?.addr) setSelectedAddr(wallet.addr);
  }, [wallet?.addr]);

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
      new Promise<boolean>((resolve) => {
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
        setPending({
          request,
          resolve: async (d: ApprovalDecision) => {
            setBusy(true);
            try {
              if (request.kind === 'connect' && d.approved && d.trust) {
                await trustSite(request.origin).catch(() => undefined);
              }
            } finally {
              setBusy(false);
              setPending(null);
              resolve(d.approved);
            }
          },
        });
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
        const addr = s.wallet?.addr;
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
        const addr = s.wallet?.addr;
        if (!s.rpc || !addr) throw new Error('RPC unavailable');
        const bi = await s.rpc.getBalance(addr);
        if (!bi.ok || !bi.result) throw new Error('Cannot fetch nonce');
        return (bi.result.pending_nonce ?? bi.result.nonce ?? 0) + 1;
      },
      requestApproval,
    }),
    [requestApproval],
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
      onSessionChange: setSessionId,
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
  }, [params, isUnlocked, host]);

  // Bridge wallet lock/unlock into dApp events.
  const prevUnlocked = useRef(isUnlocked);
  useEffect(() => {
    const h = handlerRef.current;
    if (!h) {
      prevUnlocked.current = isUnlocked;
      return;
    }
    if (prevUnlocked.current && !isUnlocked) h.emitEvent(EVENTS.WALLET_LOCKED, {});
    if (!prevUnlocked.current && isUnlocked) h.emitEvent(EVENTS.WALLET_UNLOCKED, {});
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
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <ThemeToggle />
        </div>
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
        {accounts.length > 1 && (
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
          <ApprovalPrompt request={pending.request} onDecision={pending.resolve} busy={busy} />
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
              <strong style={{ fontSize: 'var(--fs-sm)' }}>Active Wallet</strong>
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
      <Toasts />
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
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
