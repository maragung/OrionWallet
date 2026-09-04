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
import { SessionRestoring } from '../components/SessionRestoring';
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
import { Icon } from '../components/icons/Icon';
import { networkIcon } from '../components/icons/network-icon';
import { patchSettings } from '../wallet/storage';
import {
  activeNetworkInfo,
  allNetworks,
  getNetworkDef,
  networkInfoList,
  type NetworkId,
} from '../wallet/networks';
import { MAIN_WALLET_NAME, HANDOFF_TYPE } from './handoff';
import { requestAttention } from './attention';
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

/**
 * Handoff tracing, development only.
 *
 * The deferral loop below retries every 100ms while a prompt is on screen, and
 * each pass logged six values. In a production console that is a scrolling wall
 * of internal state while the user waits — and it drowns out anything they might
 * actually need to report. The trace is genuinely useful when debugging the
 * handoff, so it stays; it just no longer ships.
 */
const debugHandoff: (...args: unknown[]) => void = import.meta.env.DEV
  ? (...args) => console.log('[handoff]', ...args)
  : () => undefined;

function abbreviate(addr: string): string {
  if (addr.length <= 16) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export function ConnectApp() {
  const params = useMemo(parseParams, []);
  const store = useWalletStore();
  const { wallet, isUnlocked, isRestoringSession, rpc, initRpc, resumeSession, settings } = store;
  const { t } = useI18n();

  const [showCreate, setShowCreate] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  /**
   * Set while one or more dApp requests are parked behind the lock screen.
   *
   * It exists so the unlock screen can explain itself. A PIN prompt that appears
   * with no context is the same shape as a phishing prompt, and the correct
   * response to one of those is to close the window — so an unexplained prompt
   * costs the user the request they were trying to make.
   */
  const [unlockPrompt, setUnlockPrompt] = useState<{ origin: string } | null>(null);
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
  const pinRequestRef = useRef<{ addr: string; resolve: (w: Wallet | null) => void } | null>(null);
  const pendingRef = useRef<PendingApproval | null>(null);
  // Account bound to the live session (mirror of `sessionAccount` state).
  const sessionAddrRef = useRef<string | null>(null);

  // Signal that a prompt is waiting: focus once, chime only if the popup is in
  // the background, and flash the title until it is answered. The signal is torn
  // down on cleanup, which is what keeps the tab title from being left flashing
  // after the user has already decided.
  useEffect(() => {
    if (!pending) return;
    return requestAttention();
  }, [pending]);

  // Same signal for the unlock gate. A locked wallet with a dApp request parked
  // behind it is exactly as much "your turn" as an approval prompt is.
  useEffect(() => {
    if (!unlockPrompt) return;
    return requestAttention();
  }, [unlockPrompt]);

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
      .catch((e: unknown) => {
        // Do not blank the list: an empty picker looks like the wallet has no
        // accounts, when the accounts are there and only the read failed.
        // Read through getState so this callback stays stable: `store` changes
        // identity on every state update, which would re-run the read each time.
        useWalletStore
          .getState()
          .pushToast('error', `Could not read your accounts: ${(e as Error).message}`);
      });
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

  // A popup opened by the wallet inherits a copy of the tab's sessionStorage, so
  // a live unlock session reopens here too — a dApp request during an unlocked
  // session should not stop to ask for the PIN again.
  useEffect(() => {
    resumeSession().catch((e) => console.error('resumeSession failed:', e));
  }, [resumeSession]);

  const requestApproval = useCallback(
    (request: ApprovalRequest) =>
      new Promise<ApprovalDecision>((resolve) => {
        // Focus and the title flash are driven by the effect on `pending` above,
        // so they are set up and torn down together with the prompt itself.
        const entry = {
          request,
          resolve: async (d: ApprovalDecision) => {
            setBusy(true);
            try {
              if (request.kind === 'connect' && d.approved) {
                // The account chosen in the prompt becomes the session account,
                // and travels on the decision itself so the handler binds the
                // connection to exactly the account the user saw selected —
                // never to one left over from an earlier prompt or session.
                sessionAddrRef.current = selectedAddrRef.current;
                d = { ...d, account: selectedAddrRef.current ?? undefined };
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
        // Record that a request is waiting, so the unlock screen can say WHICH
        // site is waiting and WHY the PIN is being asked for. A bare PIN prompt
        // that appears with no explanation is indistinguishable from one the user
        // did not trigger, and the safe reaction to that is to close the window.
        setUnlockPrompt({ origin: params?.origin ?? '' });
        // Attention (focus, chime, title flash) is driven by the effect above.
      }),
    [params?.origin],
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
      getNetworkInfo: () => {
        const st = useWalletStore.getState().settings;
        return activeNetworkInfo(st?.network ?? 'devnet', st?.customNetworks);
      },
      getNetworks: () => networkInfoList(useWalletStore.getState().settings?.customNetworks),
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
      if (pendingRef.current || pinRequestRef.current || h.getInFlightCount() > 0) {
        debugHandoff(
          'deferring, pending=',
          !!pendingRef.current,
          'pin=',
          !!pinRequestRef.current,
          'inflight=',
          h.getInFlightCount(),
        );
        setTimeout(() => maybeHandoff(channel, challenge), 100);
        return;
      }
      // The main wallet window shares this origin; reach it by its stable name.
      const main = window.open('', MAIN_WALLET_NAME);
      debugHandoff(
        'main window lookup:',
        main === null ? 'null' : main === window ? 'self' : 'found',
      );
      if (!main || main === window) return; // not found — keep hosting in the popup
      // Safety net: if we accidentally got a blank window, close it and fall back.
      try {
        if (main.location.href === 'about:blank') {
          debugHandoff('got blank window, closing + fallback');
          main.close();
          return;
        }
      } catch {
        /* cross-origin read blocked — treat as the real main window */
      }
      // Re-check after the lookup: a request may have arrived (and prompted)
      // while we were resolving the window. Transferring now would strand its
      // reply. Retry instead.
      if (pendingRef.current || pinRequestRef.current || h.getInFlightCount() > 0) {
        debugHandoff(
          'deferring after lookup, pending=',
          !!pendingRef.current,
          'pin=',
          !!pinRequestRef.current,
          'inflight=',
          h.getInFlightCount(),
        );
        setTimeout(() => maybeHandoff(channel, challenge), 100);
        return;
      }
      handedOffRef.current = true;
      debugHandoff('transferring port');
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
      setUnlockPrompt(null);
    }
    prevUnlocked.current = isUnlocked;
  }, [isUnlocked]);

  // ── Network switcher ────────────────────────────────────────────────────
  const handleSwitchNetwork = useCallback(
    async (net: NetworkId) => {
      if (net === settings?.network) return;
      const def = getNetworkDef(net, settings?.customNetworks);
      if (!def) return;
      try {
        // Patch every endpoint field, exactly as the main window's NetworkSwitcher
        // does. Patching only `rpcUrl` would leave the explorer and relayer
        // pointing at the previous network.
        const updated = await patchSettings({
          network: def.id,
          rpcUrl: def.rpcUrl,
          explorerUrl: def.explorerUrl,
          relayerUrl: def.relayerUrl ?? '',
        });
        store.setSettings(updated);
        store.initRpc().catch(() => undefined);
        handlerRef.current?.emitEvent(EVENTS.NETWORK_CHANGED, {
          network: def.id,
          chainId: `octra:${def.id}`,
          networkInfo: activeNetworkInfo(def.id, settings?.customNetworks),
        });
      } catch (e) {
        // A failed settings write must not leave the popup showing a network it
        // never switched to, nor raise an unhandled rejection from the <select>.
        store.pushToast('error', `Network switch failed: ${(e as Error).message}`);
      }
    },
    [settings?.network, settings?.customNetworks, store],
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
      <div className="connect-shell">
        <div className="card connect-panel">
          <div className="card-title">
            <Icon name="alert-triangle" size={18} />
            Invalid connection request
          </div>
          <p className="hint">This page must be opened by a dApp through the Octra Wallet SDK.</p>
        </div>
      </div>
    );
  }

  if (!isUnlocked || !wallet) {
    // Reopening an inherited session takes a moment — don't ask for the PIN
    // over a wallet that is about to unlock itself.
    if (isRestoringSession) {
      return (
        <>
          <SessionRestoring />
          <Toasts />
        </>
      );
    }
    return (
      <div className="connect-shell">
        {showCreate ? (
          <CreateWallet onBack={() => setShowCreate(false)} />
        ) : (
          <UnlockWallet
            onCreate={() => setShowCreate(true)}
            notice={
              unlockPrompt ? (
                <>
                  <strong className="mono">{unlockPrompt.origin}</strong> is waiting for your
                  wallet. Unlock to answer its request — you will still be asked to approve anything
                  it wants signed.
                </>
              ) : params ? (
                <>
                  <strong className="mono">{params.origin}</strong> wants to connect to your wallet.
                  Unlock to continue.
                </>
              ) : undefined
            }
          />
        )}
        <Toasts />
      </div>
    );
  }

  const activeNetwork = settings?.network ?? 'devnet';
  // Presets plus whatever the user added by hand in Settings → Network. The
  // popup reads the same list as the main window, so a custom network is
  // selectable here the moment it exists.
  const networkOptions = allNetworks(settings?.customNetworks);
  // An id with no definition left (custom network deleted while connected)
  // would otherwise render as a blank <select>.
  const activeDef = networkOptions.find((n) => n.id === activeNetwork);
  const activeIsKnown = activeDef !== undefined;

  return (
    <div className="connect-shell">
      {/* Top bar: dropdowns + theme toggle */}
      <div className="connect-topbar">
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
        <span className="select-with-icon compact">
          <Icon name={networkIcon(activeDef ?? { id: activeNetwork })} size={14} />
          <select
            value={activeNetwork}
            onChange={(e) => void handleSwitchNetwork(e.target.value)}
            className="connect-select"
            title={settings?.rpcUrl ?? 'Network'}
          >
            {!activeIsKnown && (
              <option value={activeNetwork}>{`${activeNetwork} (unknown)`}</option>
            )}
            {networkOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {`${opt.name}${opt.custom ? ' (custom)' : ''}`}
              </option>
            ))}
          </select>
        </span>
        <ThemeToggle />
      </div>

      {pending ? (
        <div className="connect-overlay">
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
        <div className="connect-panel">
          {/* Connected header */}
          <div className="card connect-head">
            <div className="card-title centered">
              <Icon name={handshakeDone ? 'link' : 'loader'} size={18} />
              {handshakeDone ? 'Connected' : 'Establishing secure channel\u2026'}
            </div>
            <p className="mono connect-origin">{params.origin}</p>
            <button
              type="button"
              onClick={() => setShowDisconnectConfirm(true)}
              className="ghost connect-disconnect"
              disabled={!sessionId}
            >
              <Icon name="x-circle" size={16} />
              {t('connect.disconnect')}
            </button>
          </div>

          {/* Active wallet info */}
          <div className="card">
            <div className="between connect-wallet-head">
              <strong className="connect-wallet-label">
                {sessionAccount && sessionAccount !== wallet?.addr
                  ? 'Session Account'
                  : 'Active Wallet'}
              </strong>
              <span className="tag ok">
                <Icon name="unlock" size={12} />
                unlocked
              </span>
            </div>
            <div className="mono connect-addr">{displayAddr}</div>
            {sessionAccount && sessionAccount !== wallet?.addr && (
              <div className="connect-note">
                Connected with a different account than your active wallet (
                {wallet?.addr.slice(0, 8)}…). Your wallet account is unchanged.
              </div>
            )}
            {balance && (
              <div className="connect-balance">
                Balance: <strong>{balance.balance}</strong> OCT
                <span className="muted connect-nonce">nonce: {balance.nonce}</span>
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
