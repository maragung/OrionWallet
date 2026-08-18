import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { UnlockWallet } from './UnlockWallet';
import { CreateWallet } from './CreateWallet';
import { BalanceView } from './BalanceView';
import { SendForm } from './SendForm';
import { HistoryView } from './HistoryView';
import { ContractPanel } from './ContractPanel';
import { ContractViewer } from './ContractViewer';
import { StealthPanel } from './StealthPanel';
import { EncryptPanel } from './EncryptPanel';
import { DocsPanel } from './DocsPanel';
import { SettingsPanel } from './SettingsPanel';
import { AccountPicker } from './AccountPicker';
import { NetworkSwitcher } from './NetworkSwitcher';
import { ReceiveView } from './ReceiveView';
import { CirclesPanel } from './CirclesPanel';
import { BrowserPanel } from './BrowserPanel';
import { TokensView } from './TokensView';
import { Toasts } from './Toasts';
import { LoadingOverlay } from './LoadingOverlay';
import { SessionRestoring } from './SessionRestoring';
import { ErrorBoundary } from './ErrorBoundary';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ConnectApprovalHost } from './ConnectApprovalHost';
import { useTheme } from '../hooks/useTheme';
import { useAutoLock } from '../hooks/useAutoLock';
import { useI18n } from '../i18n/useI18n';
import { ConnectHandler } from '../connect/rpc-handler';
import { EVENTS } from '../sdk/protocol';
import { activeNetworkInfo } from '../wallet/networks';
import { createWalletHost, refreshHostAccounts } from '../connect/host';
import { restoreSession } from '../connect/session';
import type { Wallet } from '../wallet/wallet';
import { HANDOFF_TYPE, type ConnectHandoffMessage } from '../connect/handoff';

type Tab =
  | 'balance'
  | 'send'
  | 'receive'
  | 'history'
  | 'tokens'
  | 'encrypt'
  | 'contract'
  | 'contract-viewer'
  | 'stealth'
  | 'browser'
  | 'circles'
  | 'settings'
  | 'docs';

interface NavItem {
  id: Tab;
  labelKey: string;
  shortLabelKey: string;
  icon: string;
  group: 'Wallet' | 'Privacy' | 'Contracts' | 'Advanced';
  mobile?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  // ─── Wallet ───
  {
    id: 'balance',
    labelKey: 'nav.balance',
    shortLabelKey: 'nav.home',
    icon: '💰',
    group: 'Wallet',
    mobile: true,
  },
  {
    id: 'send',
    labelKey: 'nav.send',
    shortLabelKey: 'nav.send',
    icon: '📤',
    group: 'Wallet',
    mobile: true,
  },
  {
    id: 'receive',
    labelKey: 'nav.receive',
    shortLabelKey: 'nav.receive',
    icon: '📥',
    group: 'Wallet',
    mobile: true,
  },
  {
    id: 'history',
    labelKey: 'nav.history',
    shortLabelKey: 'nav.history',
    icon: '📜',
    group: 'Wallet',
    mobile: true,
  },
  {
    // Not in the mobile bottom bar: it already carries 5 items plus "More",
    // and adding a 6th crowds it. Reachable via the "More" sheet instead.
    id: 'tokens',
    labelKey: 'nav.tokens',
    shortLabelKey: 'nav.tokens',
    icon: '💎',
    group: 'Wallet',
  },
  // ─── Privacy ───
  {
    id: 'encrypt',
    labelKey: 'nav.encrypt',
    shortLabelKey: 'nav.encrypt',
    icon: '🔐',
    group: 'Privacy',
  },
  {
    id: 'stealth',
    labelKey: 'nav.stealth',
    shortLabelKey: 'nav.stealth',
    icon: '🤫',
    group: 'Privacy',
  },
  // ─── Contracts ───
  {
    id: 'contract',
    labelKey: 'nav.deploy',
    shortLabelKey: 'nav.deploy',
    icon: '📄',
    group: 'Contracts',
  },
  {
    id: 'contract-viewer',
    labelKey: 'nav.viewer',
    shortLabelKey: 'nav.viewer',
    icon: '🔍',
    group: 'Contracts',
  },
  // ─── Advanced ───
  {
    id: 'browser',
    labelKey: 'nav.browser',
    shortLabelKey: 'nav.browser',
    icon: '🌐',
    group: 'Advanced',
  },
  {
    id: 'circles',
    labelKey: 'nav.circles',
    shortLabelKey: 'nav.circles',
    icon: '⭕',
    group: 'Advanced',
  },
  {
    id: 'settings',
    labelKey: 'nav.settings',
    shortLabelKey: 'nav.settings',
    icon: '⚙️',
    group: 'Advanced',
    mobile: true,
  },
  {
    id: 'docs',
    labelKey: 'nav.docs',
    shortLabelKey: 'nav.docs',
    icon: '📖',
    group: 'Advanced',
  },
];

function NavGroup({
  title,
  items,
  tab,
  setTab,
  t,
}: {
  title: string;
  items: NavItem[];
  tab: Tab;
  setTab: (t: Tab) => void;
  t: (key: string) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 'var(--sp-2)' }}>
      <div className="nav-group-label">{title}</div>
      {items.map((item) => (
        <div
          key={item.id}
          className={`nav-item ${tab === item.id ? 'active' : ''}`}
          onClick={() => setTab(item.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setTab(item.id);
            }
          }}
        >
          <span className="icon">{item.icon}</span>
          <span>{t(item.labelKey)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Mobile bottom navigation.
 * Shows the primary items inline plus a "More" button that opens a sheet with
 * everything else — so no page is unreachable on a phone.
 */
function MobileNav({
  tab,
  setTab,
  t,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  t: (key: string) => string;
}) {
  const [showMore, setShowMore] = useState(false);
  const primary = NAV_ITEMS.filter((i) => i.mobile);
  const overflow = NAV_ITEMS.filter((i) => !i.mobile);
  const overflowActive = overflow.some((i) => i.id === tab);

  const select = (id: Tab) => {
    setShowMore(false);
    setTab(id);
  };

  return (
    <>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {primary.map((item) => (
          <div
            key={item.id}
            className={`mobile-nav-item ${tab === item.id ? 'active' : ''}`}
            onClick={() => select(item.id)}
            role="button"
            tabIndex={0}
            aria-current={tab === item.id ? 'page' : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                select(item.id);
              }
            }}
          >
            <span className="icon">{item.icon}</span>
            <span className="label">{t(item.shortLabelKey)}</span>
          </div>
        ))}

        {overflow.length > 0 && (
          <div
            className={`mobile-nav-item ${overflowActive ? 'active' : ''}`}
            onClick={() => setShowMore(true)}
            role="button"
            tabIndex={0}
            aria-haspopup="menu"
            aria-expanded={showMore}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowMore(true);
              }
            }}
          >
            <span className="icon">⋯</span>
            <span className="label">{t('nav.more')}</span>
          </div>
        )}
      </nav>

      {showMore && (
        <div className="sheet-overlay" onClick={() => setShowMore(false)} role="presentation">
          <div
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            role="menu"
            aria-label={t('nav.more')}
          >
            <div className="sheet-handle" />
            <div className="sheet-title">{t('nav.more')}</div>
            <div className="sheet-grid">
              {overflow.map((item) => (
                <button
                  key={item.id}
                  className={`sheet-item ${tab === item.id ? 'active' : ''}`}
                  onClick={() => select(item.id)}
                  role="menuitem"
                >
                  <span style={{ fontSize: 24 }}>{item.icon}</span>
                  <span>{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function Layout() {
  const [tab, setTab] = useState<Tab>('balance');
  const [showCreate, setShowCreate] = useState(false);
  const { t } = useI18n();
  const {
    wallet,
    isUnlocked,
    isRestoringSession,
    initRpc,
    resumeSession,
    lock,
    isLoading,
    loadingMessage,
    pvacStatus,
    pvacError,
    rpcWarning,
    settings,
  } = useWalletStore();

  // Initialize theme system (applies data-theme to <html>)
  useTheme();

  // Lock the wallet after the configured idle window, and keep the persisted
  // session's idle clock in step with real activity.
  useAutoLock();

  // Host for SDK connect sessions handed off from /connect popups (see handoff).
  // The main wallet window is long-lived, so dApp sessions survive the popup
  // closing. The host is created once and reused across handoffs.
  const mainHost = useMemo(() => createWalletHost(), []);

  // Live handlers adopted from popups, so we can tear them down on lock.
  const handlersRef = useRef<ConnectHandler[]>([]);

  // Adopt a handed-off port and restore the session the popup minted.
  const adoptHandoff = useCallback(
    (msg: ConnectHandoffMessage, port: MessagePort) => {
      console.log('[handoff] main window: adopting port, origin=', msg.origin);
      const handler = new ConnectHandler({
        host: mainHost,
        port,
        origin: msg.origin,
        challenge: msg.challenge,
        requestedCapabilities: msg.caps,
        presetAcked: true,
        onSessionChange: () => undefined,
      });
      handlersRef.current.push(handler);
      restoreSession(msg.origin)
        .then((session) => {
          console.log('[handoff] main window: session restored =', !!session);
          return handler.adoptSession(session, (msg.wallet as Wallet | null) ?? null);
        })
        .catch((e) => {
          // Adopt anyway: the dApp still needs the SESSION_ADOPTED event so it
          // re-sends anything that was lost in the port transfer. A missing
          // session surfaces as a clear UNAUTHORIZED rather than a hang.
          console.error('[handoff] session restore failed:', e);
          void handler.adoptSession(null, null);
        });
    },
    [mainHost],
  );

  // Listen for handoffs from /connect popups (same origin only).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as Partial<ConnectHandoffMessage> | undefined;
      if (!data || data.type !== HANDOFF_TYPE) return;
      console.log('[handoff] main window: handoff message received, ports=', e.ports?.length);
      // The transferred port arrives in e.ports[0].
      const port = e.ports?.[0];
      if (!port) return;
      adoptHandoff(data as ConnectHandoffMessage, port);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [adoptHandoff]);

  // Keep the host's account cache in sync with the manifest.
  useEffect(() => {
    refreshHostAccounts();
  }, [wallet]);

  // Tell connected dApps when the network changes *here*. Sessions outlive the
  // connect popup (they are handed off to this window), so by the time a user
  // switches network in the top-bar pill the popup that emitted this event is
  // usually gone. Without this, a connected dApp keeps showing the old network
  // indefinitely.
  const activeNetwork = settings?.network;
  const prevNetwork = useRef(activeNetwork);
  useEffect(() => {
    if (prevNetwork.current === activeNetwork) return;
    const had = prevNetwork.current;
    prevNetwork.current = activeNetwork;
    // Settings load asynchronously, so the first transition is undefined → the
    // stored network. That is not a change; emitting it would announce a switch
    // that never happened.
    if (!activeNetwork || !had) return;
    const info = activeNetworkInfo(activeNetwork, settings?.customNetworks);
    for (const h of handlersRef.current) {
      h.emitEvent(EVENTS.NETWORK_CHANGED, {
        network: activeNetwork,
        chainId: `octra:${activeNetwork}`,
        networkInfo: info,
      });
    }
  }, [activeNetwork, settings?.customNetworks]);

  // On lock, tear down any adopted session handlers (drops the live channel).
  const prevUnlocked = useRef(isUnlocked);
  useEffect(() => {
    if (prevUnlocked.current && !isUnlocked) {
      for (const h of handlersRef.current) h.dispose();
      handlersRef.current = [];
    }
    prevUnlocked.current = isUnlocked;
  }, [isUnlocked]);

  // Reset showCreate when wallet is locked
  useEffect(() => {
    if (!isUnlocked) {
      setShowCreate(false);
      setTab('balance');
    }
  }, [isUnlocked]);

  useEffect(() => {
    initRpc().catch((e) => {
      console.error('initRpc failed:', e);
    });
  }, [initRpc]);

  // A reload drops the in-memory wallet, so reopen the session this tab sealed
  // at unlock time. No live session (or an expired one) leaves us locked.
  useEffect(() => {
    resumeSession().catch((e) => console.error('resumeSession failed:', e));
  }, [resumeSession]);

  // Global keyboard shortcuts (desktop). Ignored while typing in a field.
  useEffect(() => {
    if (!isUnlocked) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

      // Single-key jumps
      const map: Record<string, Tab> = {
        b: 'balance',
        s: 'send',
        r: 'receive',
        h: 'history',
        p: 'encrypt',
        d: 'docs',
        ',': 'settings',
      };
      const dest = map[e.key.toLowerCase()];
      if (dest) {
        e.preventDefault();
        setTab(dest);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isUnlocked]);

  if (!isUnlocked || !wallet) {
    // Don't flash the PIN screen over a session that is about to come back.
    if (isRestoringSession) {
      return (
        <>
          <SessionRestoring />
          <Toasts />
        </>
      );
    }
    return (
      <>
        {showCreate ? (
          <CreateWallet onBack={() => setShowCreate(false)} />
        ) : (
          <UnlockWallet onCreate={() => setShowCreate(true)} />
        )}
        <Toasts />
        <LoadingOverlay loading={isLoading} message={loadingMessage} />
      </>
    );
  }

  // Group nav items for desktop sidebar
  const walletItems = NAV_ITEMS.filter((i) => i.group === 'Wallet');
  const privacyItems = NAV_ITEMS.filter((i) => i.group === 'Privacy');
  const contractItems = NAV_ITEMS.filter((i) => i.group === 'Contracts');
  const advancedItems = NAV_ITEMS.filter((i) => i.group === 'Advanced');

  // PVAC status indicator for header
  const pvacIndicator = (() => {
    switch (pvacStatus) {
      case 'loading':
        return (
          <span className="tag info" title="Loading PVAC WASM module">
            <span className="spinner" style={{ width: 8, height: 8, marginRight: 4 }} />
            PVAC…
          </span>
        );
      case 'ready':
        return (
          <span className="tag ok" title="PVAC WASM loaded and bridge initialized">
            ● PVAC
          </span>
        );
      case 'failed':
        return (
          <span className="tag err" title={`PVAC failed: ${pvacError ?? ''}`}>
            ● PVAC
          </span>
        );
      case 'unavailable':
        return (
          <span
            className="tag warn"
            title="PVAC WASM not compiled — run npm run build:wasm to enable FHE operations"
          >
            ○ PVAC
          </span>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <img src="/logo.png" alt="Octra" />
          <span className="wordmark">Orion Wallet</span>
          {pvacIndicator}
          {rpcWarning && (
            <button
              className="tag warn"
              onClick={() => setTab('settings')}
              title={`${rpcWarning}\n\nClick to open Settings → Network.`}
              style={{ border: 'none', cursor: 'pointer', minHeight: 0 }}
            >
              ⚠️ Insecure RPC
            </button>
          )}
        </div>
        <div className="actions">
          <AccountPicker onManage={() => setTab('settings')} />
          <NetworkSwitcher />
          <LanguageSwitcher />
          <button
            className="ghost icon"
            onClick={lock}
            title="Lock wallet"
            aria-label="Lock wallet"
          >
            🔒
          </button>
        </div>
      </header>

      <aside className="app-sidebar">
        <NavGroup title={t('nav.wallet')} items={walletItems} tab={tab} setTab={setTab} t={t} />
        <NavGroup title={t('nav.privacy')} items={privacyItems} tab={tab} setTab={setTab} t={t} />
        <NavGroup
          title={t('nav.contracts')}
          items={contractItems}
          tab={tab}
          setTab={setTab}
          t={t}
        />
        <NavGroup title={t('nav.advanced')} items={advancedItems} tab={tab} setTab={setTab} t={t} />
      </aside>

      <main className="app-main">
        {/* Keyed per tab so a tripped boundary resets when the user navigates
            away, and so one panel crashing never blanks the whole shell. */}
        <ErrorBoundary key={tab}>
          {tab === 'balance' && (
            <BalanceView
              onManageEncrypted={() => setTab('encrypt')}
              onSend={() => setTab('send')}
              onReceive={() => setTab('receive')}
              onHistory={() => setTab('history')}
            />
          )}
          {tab === 'send' && <SendForm />}
          {tab === 'receive' && <ReceiveView />}
          {tab === 'history' && <HistoryView />}
          {tab === 'tokens' && <TokensView />}
          {tab === 'encrypt' && <EncryptPanel />}
          {tab === 'stealth' && <StealthPanel />}
          {tab === 'contract' && <ContractPanel />}
          {tab === 'contract-viewer' && <ContractViewer />}
          {tab === 'browser' && <BrowserPanel />}
          {tab === 'circles' && <CirclesPanel />}
          {tab === 'settings' && <SettingsPanel />}
          {tab === 'docs' && <DocsPanel />}
        </ErrorBoundary>
      </main>

      <MobileNav tab={tab} setTab={setTab} t={t} />

      <ConnectApprovalHost />
      <Toasts />
      <LoadingOverlay loading={isLoading} message={loadingMessage} />
    </div>
  );
}
