import { copyText } from '../utils/clipboard';
import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { loadSettings } from '../wallet/storage';
import type { Settings } from '../wallet/storage';
import { exportPrivateKey, exportMnemonic } from '../api/wallet-api';
import {
  disablePasskeyUnlock,
  enablePasskeyUnlock,
  getPasskeyInfo,
  isPasskeySupported,
  type PasskeyInfo,
} from '../wallet/passkey';
import { ConfirmDialog } from './ConfirmDialog';
import { AccountSwitcher } from './AccountSwitcher';
import { AddressBookPanel } from './AddressBookPanel';
import { ConnectedSitesPanel } from './ConnectedSitesPanel';
import { WalletExportImport } from './WalletExportImport';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { ProcessingModal } from './ProcessingModal';
import { useI18n } from '../i18n/useI18n';
import { LANGUAGES } from '../i18n/types';
import type { LanguageCode } from '../i18n/types';
import { checkEndpoint, normalizeOrigin } from '../wallet/endpoint-policy';
import {
  allNetworks,
  getNetworkDef,
  isValidHttpUrl,
  networkIdFromName,
  type CustomNetworkDef,
} from '../wallet/networks';

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
  const [phrase, setPhrase] = useState<string | null>(null);
  const [showPhrase, setShowPhrase] = useState(false);
  const [showPhraseConfirm, setShowPhraseConfirm] = useState(false);
  const [showPrivConfirm, setShowPrivConfirm] = useState(false);
  const [passkey, setPasskey] = useState<PasskeyInfo | null>(null);
  const passkeyOk = isPasskeySupported();
  const [section, setSection] = useState<
    'general' | 'accounts' | 'contacts' | 'connections' | 'backup' | 'security'
  >('general');

  // Custom-network add form.
  const [cnName, setCnName] = useState('');
  const [cnRpc, setCnRpc] = useState('');
  const [cnExplorer, setCnExplorer] = useState('');
  const [cnRelayer, setCnRelayer] = useState('');

  useEffect(() => {
    loadSettings().then(setLocalSettings);
    getPasskeyInfo()
      .then(setPasskey)
      .catch(() => setPasskey(null));
  }, []);

  /** Verdict for the RPC URL currently in the form, with the saved allowlist. */
  const rpcVerdict = settings
    ? checkEndpoint(settings.rpcUrl, {
        allowlist: settings.allowedInsecureOrigins,
        proxyUrl: settings.rpcProxyUrl?.trim() || undefined,
      })
    : null;

  const trustOrigin = async (origin: string) => {
    if (!settings) return;
    const normalized = normalizeOrigin(origin);
    if (!normalized) return pushToast('error', `Not a usable origin: ${origin}`);
    const list = settings.allowedInsecureOrigins ?? [];
    if (list.includes(normalized)) return;
    const next: Settings = { ...settings, allowedInsecureOrigins: [...list, normalized] };
    setLocalSettings(next);
    try {
      await setSettings(next);
      pushToast('success', `${normalized} is now trusted for unencrypted RPC`);
    } catch (e) {
      pushToast('error', `Save failed: ${(e as Error).message}`);
    }
  };

  const untrustOrigin = async (origin: string) => {
    if (!settings) return;
    const next: Settings = {
      ...settings,
      allowedInsecureOrigins: (settings.allowedInsecureOrigins ?? []).filter((o) => o !== origin),
    };
    setLocalSettings(next);
    try {
      await setSettings(next);
      pushToast('success', `${origin} is no longer trusted`);
    } catch (e) {
      pushToast('error', `Save failed: ${(e as Error).message}`);
    }
  };

  const handleEnablePasskey = async () => {
    if (!wallet) return;
    try {
      const info = await run(
        'Registering passkey',
        () => enablePasskeyUnlock(wallet),
        'Follow your device prompt — it may ask twice',
      );
      setPasskey(info);
      pushToast('success', 'Passkey unlock enabled for this browser');
    } catch (e) {
      pushToast('error', (e as Error).message);
    }
  };

  const handleDisablePasskey = async () => {
    try {
      await disablePasskeyUnlock();
      setPasskey(null);
      pushToast('success', 'Passkey unlock switched off — the PIN is the only way in again');
    } catch (e) {
      pushToast('error', `Could not switch it off: ${(e as Error).message}`);
    }
  };

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

  const handleRevealPhrase = async () => {
    setShowPhraseConfirm(false);
    if (!pin) return pushToast('error', 'Enter PIN to reveal the phrase');
    await run(
      'Revealing recovery phrase',
      async () => {
        try {
          setPhrase(await exportMnemonic(wallet, pin));
          setShowPhrase(false);
          pushToast('success', 'Recovery phrase revealed — keep it off-screen when done');
        } catch (e) {
          pushToast('error', `Reveal failed: ${(e as Error).message}`);
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
    { id: 'contacts', label: 'Contacts', icon: '📇' },
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
      {section === 'contacts' && <AddressBookPanel />}
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
            <label htmlFor="network">{t('settings.network')}</label>
            <select
              id="network"
              value={settings.network}
              onChange={async (e) => {
                const id = e.target.value;
                const def = getNetworkDef(id, settings.customNetworks);
                if (!def) return;
                const next = {
                  ...settings,
                  network: def.id,
                  rpcUrl: def.rpcUrl,
                  explorerUrl: def.explorerUrl,
                  relayerUrl: def.relayerUrl ?? '',
                };
                setLocalSettings(next);
                // Apply immediately — persists and rebuilds the RPC client.
                try {
                  await setSettings(next);
                  pushToast('success', `${t('network.switched')}: ${def.name}`);
                } catch (err) {
                  pushToast('error', `${t('network.switchFailed')}: ${(err as Error).message}`);
                }
              }}
            >
              {allNetworks(settings.customNetworks).map((net) => (
                <option key={net.id} value={net.id}>
                  {net.icon ?? '🌐'} {net.name} ({net.rpcUrl})
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="rpc-url">{t('settings.rpcUrl')}</label>
            <input
              id="rpc-url"
              className="mono"
              value={settings.rpcUrl}
              onChange={(e) => setLocalSettings({ ...settings, rpcUrl: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label htmlFor="explorer-url">{t('settings.explorerUrl')}</label>
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
                  {t('settings.viewOnExplorer')} →
                </a>
              )}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="relayer-url">{t('settings.relayerUrl')}</label>
            <input
              id="relayer-url"
              className="mono"
              placeholder="http://127.0.0.1:9494"
              value={settings.relayerUrl ?? ''}
              onChange={(e) => setLocalSettings({ ...settings, relayerUrl: e.target.value })}
            />
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {t('settings.relayerHint')}
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="rpc-proxy">RPC proxy (optional)</label>
            <input
              id="rpc-proxy"
              className="mono"
              placeholder="https://proxy.example.com/?url="
              value={settings.rpcProxyUrl ?? ''}
              onChange={(e) => setLocalSettings({ ...settings, rpcProxyUrl: e.target.value })}
            />
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
              }}
            >
              The RPC URL is appended percent-encoded, so the browser only ever connects to the
              proxy. Use it to reach a node that has no TLS or no CORS headers — the proxy sees
              every request, so run your own.
            </div>
          </div>

          {rpcVerdict && rpcVerdict.kind !== 'https' && (
            <div
              style={{
                marginBottom: 'var(--sp-4)',
                padding: 'var(--sp-3)',
                background: rpcVerdict.allowed ? 'var(--bg-elevated-2)' : 'var(--warning-soft)',
                border: `1px solid ${rpcVerdict.allowed ? 'var(--border-default)' : 'var(--warning)'}`,
                borderRadius: 'var(--r-md)',
                fontSize: 'var(--fs-xs)',
              }}
            >
              <div style={{ marginBottom: 'var(--sp-2)' }}>
                {rpcVerdict.allowed ? 'ℹ️' : '⚠️'} {rpcVerdict.message}
              </div>
              {rpcVerdict.kind === 'not-allowlisted' && rpcVerdict.origin && (
                <button className="ghost" onClick={() => void trustOrigin(rpcVerdict.origin!)}>
                  Trust {rpcVerdict.origin}
                </button>
              )}
            </div>
          )}

          {(settings.allowedInsecureOrigins?.length ?? 0) > 0 && (
            <div className="form-row">
              <label>Trusted plaintext endpoints</label>
              {(settings.allowedInsecureOrigins ?? []).map((origin) => (
                <div
                  key={origin}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--sp-2)',
                    padding: 'var(--sp-1) 0',
                  }}
                >
                  <span className="mono" style={{ fontSize: 'var(--fs-xs)' }}>
                    {origin}
                  </span>
                  <button
                    className="ghost"
                    onClick={() => void untrustOrigin(origin)}
                    title={`Stop trusting ${origin}`}
                    style={{ minHeight: 28, fontSize: 'var(--fs-xs)' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="form-actions">
            <button
              className="primary"
              onClick={() => {
                for (const [val, label] of [
                  [settings.rpcUrl, t('settings.rpcUrl')],
                  [settings.explorerUrl, t('settings.explorerUrl')],
                  [settings.relayerUrl, t('settings.relayerUrl')],
                ] as const) {
                  if (val && !isValidHttpUrl(val)) {
                    pushToast('error', `${t('settings.invalidUrl')}: ${label}`);
                    return;
                  }
                }
                handleSave();
              }}
            >
              {t('settings.saveUrls')}
            </button>
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-2)',
              }}
            >
              {t('settings.networkApplyNote')}
            </div>
          </div>
        </div>
      )}

      {section === 'general' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">{t('settings.customNetworks')}</div>
          </div>
          {(settings.customNetworks?.length ?? 0) > 0 && (
            <div style={{ marginBottom: 'var(--sp-3)' }}>
              {(settings.customNetworks ?? []).map((cn) => (
                <div
                  key={cn.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--sp-2)',
                    padding: 'var(--sp-2) 0',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block' }}>
                      {cn.icon ?? '🌐'} {cn.name}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                    >
                      {cn.rpcUrl}
                    </span>
                  </span>
                  <button
                    className="ghost danger"
                    onClick={async () => {
                      const remaining = (settings.customNetworks ?? []).filter(
                        (n) => n.id !== cn.id,
                      );
                      // If the deleted network is active, fall back to devnet.
                      const fallback = settings.network === cn.id ? getNetworkDef('devnet')! : null;
                      const next: Settings = fallback
                        ? {
                            ...settings,
                            customNetworks: remaining,
                            network: fallback.id,
                            rpcUrl: fallback.rpcUrl,
                            explorerUrl: fallback.explorerUrl,
                            relayerUrl: fallback.relayerUrl ?? '',
                          }
                        : { ...settings, customNetworks: remaining };
                      setLocalSettings(next);
                      try {
                        await setSettings(next);
                        pushToast('success', `${t('settings.networkRemoved')}: ${cn.name}`);
                      } catch (err) {
                        pushToast('error', (err as Error).message);
                      }
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="form-row">
            <label htmlFor="cn-name">{t('settings.networkName')}</label>
            <input id="cn-name" value={cnName} onChange={(e) => setCnName(e.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="cn-rpc">{t('settings.rpcUrl')}</label>
            <input
              id="cn-rpc"
              className="mono"
              placeholder="https://…/rpc"
              value={cnRpc}
              onChange={(e) => setCnRpc(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="cn-explorer">{t('settings.explorerUrl')}</label>
            <input
              id="cn-explorer"
              className="mono"
              placeholder="https://…"
              value={cnExplorer}
              onChange={(e) => setCnExplorer(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="cn-relayer">{t('settings.relayerUrl')}</label>
            <input
              id="cn-relayer"
              className="mono"
              placeholder="http://127.0.0.1:9494"
              value={cnRelayer}
              onChange={(e) => setCnRelayer(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button
              className="primary"
              onClick={async () => {
                const name = cnName.trim();
                if (!name) {
                  pushToast('error', t('settings.networkNameRequired'));
                  return;
                }
                if (!isValidHttpUrl(cnRpc)) {
                  pushToast('error', `${t('settings.invalidUrl')}: ${t('settings.rpcUrl')}`);
                  return;
                }
                if (cnExplorer && !isValidHttpUrl(cnExplorer)) {
                  pushToast('error', `${t('settings.invalidUrl')}: ${t('settings.explorerUrl')}`);
                  return;
                }
                if (cnRelayer && !isValidHttpUrl(cnRelayer)) {
                  pushToast('error', `${t('settings.invalidUrl')}: ${t('settings.relayerUrl')}`);
                  return;
                }
                const existing = allNetworks(settings.customNetworks).map((n) => n.id);
                const def: CustomNetworkDef = {
                  id: networkIdFromName(name, existing),
                  name,
                  rpcUrl: cnRpc.trim(),
                  explorerUrl: cnExplorer.trim() || cnRpc.trim(),
                  relayerUrl: cnRelayer.trim() || undefined,
                  icon: '🌐',
                };
                const next: Settings = {
                  ...settings,
                  customNetworks: [...(settings.customNetworks ?? []), def],
                };
                setLocalSettings(next);
                try {
                  await setSettings(next);
                  pushToast('success', `${t('settings.networkAdded')}: ${name}`);
                  setCnName('');
                  setCnRpc('');
                  setCnExplorer('');
                  setCnRelayer('');
                } catch (err) {
                  pushToast('error', (err as Error).message);
                }
              }}
            >
              {t('settings.addNetwork')}
            </button>
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
            <div className="card-title">Session &amp; Auto-Lock</div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            While the session is alive, reloading the page brings the wallet back without the PIN.
            The keys are sealed for this browser tab only: closing it, locking the wallet, or
            letting the session expire ends it, and an unlock is never kept longer than 8 hours.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--sp-2)',
              marginBottom: 'var(--sp-3)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={settings.keepUnlocked !== false}
              onChange={async (e) => {
                const next: Settings = { ...settings, keepUnlocked: e.target.checked };
                setLocalSettings(next);
                try {
                  // Applies to the session already in flight, not just the next
                  // unlock: turning this off drops the sealed keys right away.
                  await setSettings(next);
                  pushToast(
                    'success',
                    next.keepUnlocked
                      ? 'Reloading this tab will keep the wallet unlocked'
                      : 'Reloading this tab will now ask for your PIN',
                  );
                } catch (err) {
                  pushToast('error', `Save failed: ${(err as Error).message}`);
                }
              }}
            />
            <span>
              Stay unlocked after a page refresh
              <span
                style={{ display: 'block', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}
              >
                Turn off to require the PIN on every reload.
              </span>
            </span>
          </label>
          <div className="form-row">
            <label htmlFor="autolock">Auto-lock after inactivity</label>
            <select
              id="autolock"
              value={String(settings.autoLockMinutes ?? 30)}
              onChange={async (e) => {
                const minutes = Number(e.target.value);
                const next: Settings = { ...settings, autoLockMinutes: minutes };
                setLocalSettings(next);
                try {
                  await setSettings(next);
                  pushToast(
                    'success',
                    minutes > 0
                      ? `Auto-lock set to ${minutes} minutes`
                      : 'Auto-lock disabled for this tab',
                  );
                } catch (err) {
                  pushToast('error', `Save failed: ${(err as Error).message}`);
                }
              }}
            >
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes (default)</option>
              <option value="60">1 hour</option>
              <option value="0">Never (until the tab closes)</option>
            </select>
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
              }}
            >
              Counted from your last interaction — clicks, typing and scrolling all reset it. The
              8-hour cap on a single unlock applies either way.
            </div>
          </div>
        </div>
      )}

      {section === 'security' && (
        <div className="card" style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="card-header">
            <div className="card-title">Passkey Unlock</div>
            {passkey && (
              <span className="tag ok" style={{ fontSize: 10 }}>
                enabled
              </span>
            )}
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            Opens the wallet with this device&apos;s fingerprint, face or screen lock instead of the
            PIN. The keys are sealed with a value only your authenticator can reproduce, so the
            stored copy is useless on its own — but anyone who can pass this device&apos;s unlock
            can open the wallet. The PIN is still required to export keys, change the PIN or derive
            accounts, and it keeps working as the way in.
          </p>
          {!passkeyOk ? (
            <div
              style={{
                padding: 'var(--sp-3)',
                background: 'var(--warning-soft)',
                border: '1px solid var(--warning)',
                borderRadius: 'var(--r-md)',
                fontSize: 'var(--fs-xs)',
              }}
            >
              ⚠️ This browser cannot use passkeys here. They need a secure context — https:// or
              localhost.
            </div>
          ) : passkey ? (
            <>
              <div
                style={{
                  padding: 'var(--sp-3)',
                  background: 'var(--bg-elevated-2)',
                  borderRadius: 'var(--r-md)',
                  fontSize: 'var(--fs-xs)',
                  marginBottom: 'var(--sp-3)',
                }}
              >
                Registered for <strong>{passkey.name}</strong>{' '}
                <span className="mono">
                  {passkey.addr.slice(0, 14)}…{passkey.addr.slice(-6)}
                </span>
                <br />
                Added {new Date(passkey.createdAt).toLocaleString()}
              </div>
              <div className="form-actions">
                <button className="ghost" onClick={() => void handleDisablePasskey()}>
                  Turn off passkey unlock
                </button>
              </div>
            </>
          ) : wallet?.watchOnly ? (
            <div
              style={{
                padding: 'var(--sp-3)',
                background: 'var(--bg-elevated-2)',
                borderRadius: 'var(--r-md)',
                fontSize: 'var(--fs-xs)',
              }}
            >
              👁 This is a watch-only account — it holds no keys, so there is nothing for a passkey
              to seal. Switch to an account with keys to register one.
            </div>
          ) : (
            <div className="form-actions">
              <button onClick={() => void handleEnablePasskey()} disabled={!wallet}>
                👆 Enable passkey unlock
              </button>
            </div>
          )}
        </div>
      )}

      {section === 'security' && (
        <div className="card" style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="card-header">
            <div className="card-title">Recovery Phrase</div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            Shows the 12-word BIP39 phrase for this account. It restores the wallet on any device,
            so treat it exactly like the funds themselves. Uses the PIN field below.
          </p>
          <div className="form-actions">
            <button
              onClick={() => {
                if (!pin) return pushToast('error', 'Enter PIN to reveal the phrase');
                setShowPhraseConfirm(true);
              }}
              disabled={!pin}
            >
              Reveal Recovery Phrase
            </button>
          </div>
          {phrase && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: 'var(--warning-soft)',
                border: '1px solid var(--warning)',
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--warning)', fontWeight: 600 }}>
                  ⚠️ Recovery phrase (never share it)
                </span>
                <button
                  type="button"
                  className="ghost icon"
                  onClick={() => setShowPhrase(!showPhrase)}
                  title={showPhrase ? 'Hide' : 'Show'}
                  aria-label={showPhrase ? 'Hide recovery phrase' : 'Show recovery phrase'}
                  style={{ minHeight: 28, minWidth: 28, fontSize: 14 }}
                >
                  {showPhrase ? '🙈' : '👁️'}
                </button>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 12,
                  wordBreak: 'break-word',
                  filter: showPhrase ? 'none' : 'blur(6px)',
                  transition: 'filter var(--t-base)',
                  padding: '4px 0',
                }}
              >
                {phrase}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="ghost" onClick={() => copyText(phrase)}>
                  Copy
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    setPhrase(null);
                    setShowPhrase(false);
                  }}
                >
                  Hide & clear
                </button>
              </div>
            </div>
          )}
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
        open={showPhraseConfirm}
        icon="📝"
        title="Reveal Recovery Phrase"
        message="This shows your 12-word recovery phrase on screen. Anyone who reads or photographs it gains full control of this wallet on any device. Only proceed somewhere private."
        confirmLabel="Reveal Phrase"
        cancelLabel="Cancel"
        onConfirm={handleRevealPhrase}
        onCancel={() => setShowPhraseConfirm(false)}
        details={`Wallet: ${wallet.addr}`}
      />

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
