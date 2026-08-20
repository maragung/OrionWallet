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
import { PageHead } from './PageHead';
import { Icon, networkIcon, type IconName } from './icons';
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
        <div className="stack">
          <div className="skeleton title" />
          <div className="skeleton row" />
          <div className="skeleton row" />
          <div className="field-note">Loading settings…</div>
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
            <span className="spinner" />
            Loading...
          </span>
        );
      case 'ready':
        return (
          <span className="tag ok">
            <Icon name="check-circle" size={12} /> Ready
          </span>
        );
      case 'failed':
        return (
          <span className="tag err">
            <Icon name="x-circle" size={12} /> Failed
          </span>
        );
      case 'unavailable':
        return (
          <span className="tag warn">
            <Icon name="alert-triangle" size={12} /> Unavailable
          </span>
        );
      default:
        return <span className="tag">{pvacStatus}</span>;
    }
  })();

  const SECTIONS: Array<{ id: typeof section; label: string; icon: IconName }> = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'accounts', label: 'Accounts', icon: 'users' },
    { id: 'contacts', label: 'Contacts', icon: 'contact' },
    { id: 'connections', label: 'Connections', icon: 'link' },
    { id: 'backup', label: 'Backup', icon: 'save' },
    { id: 'security', label: 'Security', icon: 'key' },
  ];

  return (
    <div className="page">
      <PageHead
        icon="settings"
        title="Settings"
        sub="Appearance, network endpoints, accounts and the keys behind them."
      />

      {/* Settings sub-navigation */}
      <div className="tab-bar" role="tablist" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`tab ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
            role="tab"
            aria-selected={section === s.id}
          >
            <Icon name={s.icon} size={16} />
            {s.label}
          </button>
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
            {/* The options are text — an <option> cannot hold an SVG — so the
                selected mode's icon is drawn beside the closed control. */}
            <div className="select-with-icon">
              <Icon
                name={themeMode === 'dark' ? 'moon' : themeMode === 'light' ? 'sun' : 'monitor'}
                size={16}
              />
              <select
                id="theme"
                value={themeMode}
                onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
              >
                <option value="dark">{t('settings.themeDark')}</option>
                <option value="light">{t('settings.themeLight')}</option>
                <option value="system">{t('settings.themeSystem')}</option>
              </select>
            </div>
            {/* This note used to read "Done — 20 languages available." under *Theme*:
                the language row's helper text, prefixed with an unrelated
                `common.done`. Each control now describes itself. */}
            <div className="field-note">Dark, light, or follow your system setting.</div>
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
            <div className="field-note">
              20 languages. Switches instantly, with no page refresh.
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
              {/* No glyph here on purpose: an <option> is drawn by the OS and cannot
                  contain an SVG, and the emoji that used to stand in rendered
                  differently in every browser's dropdown. The name and URL identify
                  the network without it. */}
              {allNetworks(settings.customNetworks).map((net) => (
                <option key={net.id} value={net.id}>
                  {net.name} ({net.rpcUrl})
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
            {settings.explorerUrl && (
              <div className="field-note">
                <a
                  href={`${settings.explorerUrl}/account/${wallet.addr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('settings.viewOnExplorer')}
                </a>
                <Icon name="external-link" size={12} />
              </div>
            )}
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
            <div className="field-note">{t('settings.relayerHint')}</div>
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
            <div className="field-note">
              The RPC URL is appended percent-encoded, so the browser only ever connects to the
              proxy. Use it to reach a node that has no TLS or no CORS headers — the proxy sees
              every request, so run your own.
            </div>
          </div>

          {rpcVerdict && rpcVerdict.kind !== 'https' && (
            <div className={`info-box spaced ${rpcVerdict.allowed ? '' : 'warn'}`}>
              <Icon name={rpcVerdict.allowed ? 'info' : 'alert-triangle'} size={16} />
              <div className="stack tight grow">
                <span>{rpcVerdict.message}</span>
                {rpcVerdict.kind === 'not-allowlisted' && rpcVerdict.origin && (
                  <button
                    className="ghost btn-sm self-start"
                    onClick={() => void trustOrigin(rpcVerdict.origin!)}
                  >
                    <Icon name="shield-check" size={14} /> Trust {rpcVerdict.origin}
                  </button>
                )}
              </div>
            </div>
          )}

          {(settings.allowedInsecureOrigins?.length ?? 0) > 0 && (
            <div className="form-row">
              <label>Trusted plaintext endpoints</label>
              {(settings.allowedInsecureOrigins ?? []).map((origin) => (
                <div key={origin} className="data-row">
                  <span className="data-row-main data-row-sub mono">{origin}</span>
                  <button
                    className="ghost danger btn-sm"
                    onClick={() => void untrustOrigin(origin)}
                    title={`Stop trusting ${origin}`}
                  >
                    <Icon name="trash" size={14} /> Remove
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
              <Icon name="save" size={16} /> {t('settings.saveUrls')}
            </button>
          </div>
          {/* Outside `.form-actions`: that is a flex row, so the note used to sit
              beside the button and be squeezed to one word per line on a phone. */}
          <div className="field-note">{t('settings.networkApplyNote')}</div>
        </div>
      )}

      {section === 'general' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">{t('settings.customNetworks')}</div>
          </div>
          {(settings.customNetworks?.length ?? 0) > 0 && (
            <div className="data-rows">
              {(settings.customNetworks ?? []).map((cn) => (
                <div key={cn.id} className="data-row">
                  <Icon name={networkIcon(cn)} size={18} />
                  <span className="data-row-main">
                    {cn.name}
                    <span className="data-row-sub mono">{cn.rpcUrl}</span>
                  </span>
                  <button
                    className="ghost danger btn-sm"
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
                    <Icon name="trash" size={14} /> {t('common.delete')}
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
                  // Stored data, not a rendered glyph: `NetworkDef.icon` is
                  // persisted in settings and handed to dApps over the connect API,
                  // and `networkIcon()` maps it to one of our own stroke icons for
                  // display. Changing the field would be a breaking data change for
                  // a cosmetic reason.
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
              <Icon name="plus" size={16} /> {t('settings.addNetwork')}
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
          <p className="card-desc">
            The PVAC WASM module provides encrypted balance operations (FHE) and zero-knowledge
            proofs. It is automatically loaded when a wallet is unlocked — no manual action
            required.
          </p>

          <div className="stat-grid">
            <div>
              <div className="stat-label">WASM Module</div>
              <div className="stat-value">
                {pvacAvailable ? (
                  <span className="ok-text">
                    <Icon name="check-circle" size={14} /> Loaded
                  </span>
                ) : (
                  <span className="warn-text">
                    <Icon name="circle-dot" size={14} /> Not loaded
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="stat-label">Bridge Initialized</div>
              <div className="stat-value">
                {pvacBridgeReady ? (
                  <span className="ok-text">
                    <Icon name="check-circle" size={14} /> Ready (FHE keygen done)
                  </span>
                ) : (
                  <span className="muted">
                    <Icon name="circle-dot" size={14} /> Not initialized
                  </span>
                )}
              </div>
            </div>
          </div>

          {pvacError && (
            <div className="info-box err spaced" role="alert">
              <Icon name="alert-octagon" size={16} />
              <span className="mono-line">
                <strong>Error:</strong> {pvacError}
              </span>
            </div>
          )}

          {pvacStatus === 'unavailable' && (
            <div className="info-box warn spaced">
              <Icon name="alert-triangle" size={16} />
              <span>
                Encrypted balance (FHE) is unavailable. All standard wallet features — send,
                receive, history, and contracts — work normally.
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
              </span>
            </div>
          )}

          <div className="form-actions start">
            <button
              className="ghost"
              onClick={handleReloadPvac}
              disabled={pvacStatus === 'loading'}
            >
              {pvacStatus === 'loading' ? (
                <span className="spinner" />
              ) : (
                <>
                  <Icon name="refresh" size={16} /> Reload PVAC
                </>
              )}
            </button>
          </div>

          <div className="info-box spaced-top">
            <Icon name="info" size={16} />
            <span>
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
            </span>
          </div>
        </div>
      )}

      {section === 'security' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Session &amp; Auto-Lock</div>
          </div>
          <p className="card-desc">
            While the session is alive, reloading the page brings the wallet back without the PIN.
            The keys are sealed for this browser tab only: closing it, locking the wallet, or
            letting the session expire ends it, and an unlock is never kept longer than 8 hours.
          </p>
          <label className="check-row">
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
              <span className="check-sub">Turn off to require the PIN on every reload.</span>
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
            <div className="field-note">
              Counted from your last interaction — clicks, typing and scrolling all reset it. The
              8-hour cap on a single unlock applies either way.
            </div>
          </div>
        </div>
      )}

      {section === 'security' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Icon name="fingerprint" size={18} /> Passkey Unlock
            </div>
            {passkey && (
              <span className="tag ok">
                <Icon name="check" size={12} /> enabled
              </span>
            )}
          </div>
          <p className="card-desc">
            Opens the wallet with this device&apos;s fingerprint, face or screen lock instead of the
            PIN. The keys are sealed with a value only your authenticator can reproduce, so the
            stored copy is useless on its own — but anyone who can pass this device&apos;s unlock
            can open the wallet. The PIN is still required to export keys, change the PIN or derive
            accounts, and it keeps working as the way in.
          </p>
          {!passkeyOk ? (
            <div className="info-box warn">
              <Icon name="alert-triangle" size={16} />
              <span>
                This browser cannot use passkeys here. They need a secure context — https:// or
                localhost.
              </span>
            </div>
          ) : passkey ? (
            <>
              <div className="info-box ok">
                <Icon name="shield-check" size={16} />
                <span>
                  Registered for <strong>{passkey.name}</strong>{' '}
                  <span className="mono">
                    {passkey.addr.slice(0, 14)}…{passkey.addr.slice(-6)}
                  </span>
                  <br />
                  Added {new Date(passkey.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="form-actions">
                <button className="ghost danger" onClick={() => void handleDisablePasskey()}>
                  Turn off passkey unlock
                </button>
              </div>
            </>
          ) : wallet?.watchOnly ? (
            <div className="info-box">
              <Icon name="eye" size={16} />
              <span>
                This is a watch-only account — it holds no keys, so there is nothing for a passkey
                to seal. Switch to an account with keys to register one.
              </span>
            </div>
          ) : (
            <div className="form-actions">
              <button onClick={() => void handleEnablePasskey()} disabled={!wallet}>
                <Icon name="fingerprint" size={16} /> Enable passkey unlock
              </button>
            </div>
          )}
        </div>
      )}

      {section === 'security' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Icon name="file-text" size={18} /> Recovery Phrase
            </div>
          </div>
          <p className="card-desc">
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
              <Icon name="eye" size={16} /> Reveal Recovery Phrase
            </button>
          </div>
          {phrase && (
            <div className="secret-box">
              <div className="secret-head">
                <span className="warn-text">
                  <Icon name="alert-triangle" size={14} /> Recovery phrase (never share it)
                </span>
                <button
                  type="button"
                  className="icon-btn plain"
                  onClick={() => setShowPhrase(!showPhrase)}
                  title={showPhrase ? 'Hide' : 'Show'}
                  aria-label={showPhrase ? 'Hide recovery phrase' : 'Show recovery phrase'}
                >
                  <Icon name={showPhrase ? 'eye-off' : 'eye'} size={16} />
                </button>
              </div>
              <div className={`secret-value ${showPhrase ? '' : 'blurred'}`}>{phrase}</div>
              <div className="row tight">
                <button className="ghost btn-sm" onClick={() => copyText(phrase)}>
                  <Icon name="copy" size={14} /> Copy
                </button>
                <button
                  className="ghost btn-sm"
                  onClick={() => {
                    setPhrase(null);
                    setShowPhrase(false);
                  }}
                >
                  <Icon name="eye-off" size={14} /> Hide &amp; clear
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {section === 'security' && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Icon name="key" size={18} /> Export Private Key
            </div>
          </div>
          <p className="card-desc">
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
              <Icon name="key" size={16} /> Export Private Key
            </button>
          </div>
          {privKey && (
            <div className="secret-box danger">
              <div className="secret-head">
                <span className="err-text">
                  <Icon name="alert-triangle" size={14} /> Private Key (do not share!)
                </span>
              </div>
              <div className="secret-value">{privKey}</div>
              <div className="row tight">
                <button className="ghost btn-sm" onClick={() => copyText(privKey)}>
                  <Icon name="copy" size={14} /> Copy
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={showPhraseConfirm}
        icon="file-text"
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
        icon="key"
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
    </div>
  );
}
