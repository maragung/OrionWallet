import { copyText } from '../utils/clipboard';
import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { loadSettings } from '../wallet/storage';
import type { Settings } from '../wallet/storage';
import { exportPrivateKey } from '../api/wallet-api';
import { ConfirmDialog } from './ConfirmDialog';
import { AccountSwitcher } from './AccountSwitcher';
import { ConnectedSitesPanel } from './ConnectedSitesPanel';
import { WalletExportImport } from './WalletExportImport';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { ProcessingModal } from './ProcessingModal';
import { useI18n } from '../i18n/useI18n';
import { LANGUAGES } from '../i18n/types';
import type { LanguageCode } from '../i18n/types';

export function SettingsPanel() {
  const {
    wallet,
    setSettings,
    pushToast,
    pvacStatus,
    pvacError,
    pvacAvailable,
    pvacBridgeReady,
    reloadPvac,
  } = useWalletStore();
  const panelLoading = usePanelLoading();
  const { run } = panelLoading;
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { t, lang, setLang } = useI18n();
  const [settings, setLocalSettings] = useState<Settings | null>(null);
  const [pin, setPin] = useState('');
  const [privKey, setPrivKey] = useState<string | null>(null);
  const [showPrivConfirm, setShowPrivConfirm] = useState(false);
  const [section, setSection] = useState<
    'general' | 'accounts' | 'connections' | 'backup' | 'security'
  >('general');

  useEffect(() => {
    loadSettings().then(setLocalSettings);
  }, []);

  // `settings` loads asynchronously from IndexedDB. Render a skeleton instead
  // of nothing so the settings page never flashes blank.
  if (!wallet || !settings) {
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">Settings</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
          <div className="skeleton" style={{ height: 20, width: 160 }} />
          <div className="skeleton" style={{ height: 36 }} />
          <div className="skeleton" style={{ height: 36 }} />
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            Loading settings…
          </div>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    await run(
      'Saving settings',
      async () => {
        try {
          await setSettings(settings);
          pushToast('success', 'Settings saved');
        } catch (e) {
          pushToast('error', `Save failed: ${(e as Error).message}`);
        }
      },
      'Persisting your preferences…',
    );
  };

  const handleExportPriv = async () => {
    setShowPrivConfirm(false);
    if (!pin) return pushToast('error', 'Enter PIN to authorize export');
    await run(
      'Exporting private key',
      async () => {
        try {
          const priv = await exportPrivateKey(wallet, pin);
          setPrivKey(priv);
          pushToast('success', 'Private key exported (handle with care!)');
        } catch (e) {
          pushToast('error', `Export failed: ${(e as Error).message}`);
        }
      },
      'Decrypting the keystore…',
    );
  };

  const handleReloadPvac = async () => {
    await run(
      'Reloading PVAC',
      async () => {
        await reloadPvac();
      },
      'Re-initialising the FHE bridge…',
    );
  };

  const pvacStatusTag = (() => {
    switch (pvacStatus) {
      case 'idle':
        return <span className="tag">Idle</span>;
      case 'loading':
        return (
          <span className="tag info">
            <span className="spinner" style={{ marginRight: 6 }} />
            Loading...
          </span>
        );
      case 'ready':
        return <span className="tag ok">● Ready</span>;
      case 'failed':
        return <span className="tag err">● Failed</span>;
      case 'unavailable':
        return <span className="tag warn">● Unavailable</span>;
      default:
        return <span className="tag">{pvacStatus}</span>;
    }
  })();

  const SECTIONS: Array<{ id: typeof section; label: string; icon: string }> = [
    { id: 'general', label: 'General', icon: '⚙️' },
    { id: 'accounts', label: 'Accounts', icon: '👥' },
    { id: 'connections', label: 'Connections', icon: '🔗' },
    { id: 'backup', label: 'Backup', icon: '💾' },
    { id: 'security', label: 'Security', icon: '🔑' },
  ];

  return (
    <>
      {/* Settings sub-navigation */}
      <div className="tab-bar" style={{ marginBottom: 'var(--sp-4)' }}>
        {SECTIONS.map((s) => (
          <div
            key={s.id}
            className={`tab ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setSection(s.id);
              }
            }}
          >
            <span style={{ marginRight: 'var(--sp-1)' }}>{s.icon}</span>
            {s.label}
          </div>
        ))}
      </div>

      {section === 'accounts' && <AccountSwitcher />}
      {section === 'connections' && <ConnectedSitesPanel />}
      {section === 'backup' && <WalletExportImport />}

      {section === 'general' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">{t('settings.appearance')}</div>
          </div>
          <div className="form-row">
            <label htmlFor="theme">{t('settings.theme')}</label>
            <select
              id="theme"
              value={themeMode}
              onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
            >
              <option value="dark">{t('settings.themeDark')}</option>
              <option value="light">{t('settings.themeLight')}</option>
              <option value="system">{t('settings.themeSystem')}</option>
            </select>
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-2)',
              }}
            >
              {t('common.done')} — 20 languages available.
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="language">{t('settings.language')}</label>
            <select
              id="language"
              value={lang}
              onChange={(e) => setLang(e.target.value as LanguageCode)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.flag} {l.name} ({l.englishName})
                </option>
              ))}
            </select>
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-2)',
              }}
            >
              {t('common.done')} — Switch instantly without page refresh.
            </div>
          </div>
        </div>
      )}

      {section === 'general' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Network Settings</div>
          </div>
          <div className="form-row">
            <label htmlFor="network">Network</label>
            <select
              id="network"
              value={settings.network}
              onChange={async (e) => {
                const network = e.target.value as 'devnet' | 'mainnet';
                const rpcUrl =
                  network === 'devnet'
                    ? 'https://devnet.octrascan.io/rpc'
                    : 'https://octra.network/rpc';
                const explorerUrl =
                  network === 'devnet' ? 'https://devnet.octrascan.io' : 'https://octrascan.io';
                const next = { ...settings, network, rpcUrl, explorerUrl };
                setLocalSettings(next);
                // Apply immediately — persists and rebuilds the RPC client.
                try {
                  await setSettings(next);
                  pushToast('success', `Switched to ${network.toUpperCase()}`);
                } catch (err) {
                  pushToast('error', `Network switch failed: ${(err as Error).message}`);
                }
              }}
            >
              <option value="devnet">🧪 Devnet (https://devnet.octrascan.io/rpc)</option>
              <option value="mainnet">🚀 Mainnet (https://octra.network/rpc)</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="rpc-url">RPC URL (JSON-RPC endpoint)</label>
            <input
              id="rpc-url"
              className="mono"
              value={settings.rpcUrl}
              onChange={(e) => setLocalSettings({ ...settings, rpcUrl: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label htmlFor="explorer-url">Explorer URL</label>
            <input
              id="explorer-url"
              className="mono"
              value={settings.explorerUrl || 'https://devnet.octrascan.io'}
              onChange={(e) => setLocalSettings({ ...settings, explorerUrl: e.target.value })}
            />
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {settings.explorerUrl && (
                <a
                  href={`${settings.explorerUrl}/account/${wallet.addr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View wallet on explorer →
                </a>
              )}
            </div>
          </div>
          <div className="form-actions">
            <button className="primary" onClick={handleSave}>
              Save custom URLs
            </button>
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-2)',
              }}
            >
              Network selection applies immediately. Only manual URL edits need saving.
            </div>
          </div>
        </div>
      )}

      {section === 'general' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">PVAC (FHE) Module — Auto-Load</div>
            {pvacStatusTag}
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            The PVAC WASM module provides encrypted balance operations (FHE) and zero-knowledge
            proofs. It is automatically loaded when a wallet is unlocked — no manual action
            required.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              marginBottom: 12,
              padding: 12,
              background: 'var(--bg-tertiary)',
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <div>
              <div style={{ color: 'var(--text-muted)' }}>WASM Module</div>
              <div style={{ marginTop: 2 }}>
                {pvacAvailable ? (
                  <span style={{ color: 'var(--success)' }}>✓ Loaded</span>
                ) : (
                  <span style={{ color: 'var(--warning)' }}>○ Not loaded</span>
                )}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)' }}>Bridge Initialized</div>
              <div style={{ marginTop: 2 }}>
                {pvacBridgeReady ? (
                  <span style={{ color: 'var(--success)' }}>✓ Ready (FHE keygen done)</span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>○ Not initialized</span>
                )}
              </div>
            </div>
          </div>

          {pvacError && (
            <div
              style={{
                marginBottom: 12,
                padding: 8,
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--error)',
                wordBreak: 'break-word',
              }}
            >
              <strong>Error:</strong> {pvacError}
            </div>
          )}

          {pvacStatus === 'unavailable' && (
            <div
              style={{
                marginBottom: 12,
                padding: 12,
                background: 'var(--bg-elevated-2)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              <span style={{ color: 'var(--warning)' }}>
                ⚠ Encrypted balance (FHE) is unavailable.
              </span>{' '}
              All standard wallet features — send, receive, history, and contracts — work normally.
              {pvacError ? (
                <>
                  <br />
                  <br />
                  The diagnosis and the exact fix are shown in the Error box above.
                </>
              ) : (
                <>
                  <br />
                  To enable FHE operations, build the WASM module: <code>npm run build:wasm</code>
                </>
              )}
            </div>
          )}

          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            <button
              className="ghost"
              onClick={handleReloadPvac}
              disabled={pvacStatus === 'loading'}
            >
              {pvacStatus === 'loading' ? <span className="spinner" /> : '↻ Reload PVAC'}
            </button>
          </div>

          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: 'var(--bg-tertiary)',
              borderRadius: 8,
              fontSize: 11,
              color: 'var(--text-muted)',
            }}
          >
            <strong>How auto-load works:</strong>
            <br />
            1. Wallet unlock triggers <code>setWallet()</code> in the Zustand store
            <br />
            2. Store calls <code>loadPvacWasm()</code> which dynamically imports{' '}
            <code>{`${import.meta.env.BASE_URL}wasm/pvac.js`}</code> {/* @vite-ignore */}
            <br />
            3. <code>WasmPvacBridge.init(privB64)</code> runs FHE keygen from the wallet seed
            <br />
            4. Status updates flow to <code>pvacStatus</code> ('loading' → 'ready' / 'failed' /
            'unavailable')
          </div>
        </div>
      )}

      {section === 'security' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Export Private Key</div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            Exports the 64-byte Ed25519 secret key (seed||pub) as base64. Anyone with this key can
            control your wallet — handle with extreme care.
          </p>
          <div className="form-row">
            <label htmlFor="expin">PIN (to authorize export)</label>
            <input
              id="expin"
              type="password"
              className="mono"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button
              className="danger"
              onClick={() => {
                if (!pin) return pushToast('error', 'Enter PIN to authorize export');
                setShowPrivConfirm(true);
              }}
              disabled={!pin}
            >
              Export Private Key
            </button>
          </div>
          {privKey && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: 8,
              }}
            >
              <div
                style={{ fontSize: 12, color: 'var(--error)', marginBottom: 4, fontWeight: 600 }}
              >
                ⚠️ Private Key (do not share!)
              </div>
              <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                {privKey}
              </div>
              <button className="ghost" style={{ marginTop: 8 }} onClick={() => copyText(privKey)}>
                Copy
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={showPrivConfirm}
        danger
        icon="🔑"
        title="Export Private Key"
        message="This reveals your raw Ed25519 secret key on screen. Anyone who sees it gains full control of your wallet and funds. Only proceed in a private, secure environment."
        confirmLabel="Reveal Private Key"
        cancelLabel="Cancel"
        onConfirm={handleExportPriv}
        onCancel={() => setShowPrivConfirm(false)}
        details={`Wallet: ${wallet.addr}`}
      />

      <ProcessingModal
        open={panelLoading.loading}
        title={panelLoading.title}
        message={panelLoading.message}
        dismissible
        onClose={panelLoading.hide}
      />
    </>
  );
}
