import { useCallback, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { useI18n } from '../i18n/useI18n';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { Icon, type IconName } from './icons';
import type { LanguageCode } from '../i18n/types';

/**
 * The header's overflow menu.
 *
 * Before this, the top bar carried eight controls side by side — logo, wordmark, a
 * PVAC status tag, an insecure-RPC warning, account, network, language, lock — and
 * then hid four of them below 768px, which is how the wallet ended up with a theme
 * control that `Layout` never mounted at all and a PVAC indicator no phone user
 * could see. Only the three things you act on frequently stay inline (account,
 * network, and — on a wide screen — theme and lock); everything occasional moves
 * in here.
 *
 * It reuses `useAnchoredMenu` rather than a new popover: that hook already solves
 * the two bugs a header dropdown runs into, namely the `overflow: hidden` action
 * row clipping it on phones and `.app-header`'s own stacking context trapping it
 * under a toast. See `tests/e2e/network-switch-mobile.spec.ts`.
 */
export function HeaderMenu({
  onOpenSettings,
  onLock,
}: {
  onOpenSettings: () => void;
  onLock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showLangs, setShowLangs] = useState(false);
  const { pvacStatus, pvacError, rpcWarning } = useWalletStore();
  const { mode, setMode } = useTheme();
  const { lang, setLang, languages, currentLanguage } = useI18n();

  const close = useCallback(() => {
    setOpen(false);
    // Collapse the language list too, so reopening the menu always shows the same
    // short menu rather than whatever state it was left in.
    setShowLangs(false);
  }, []);

  const { anchorRef, menuRef, style, portal } = useAnchoredMenu<HTMLButtonElement>(open, {
    align: 'right',
    width: 268,
    maxHeight: 460,
    onDismiss: close,
  });

  const pickTheme = (m: ThemeMode) => {
    void setMode(m);
    close();
  };
  const pickLang = (code: LanguageCode) => {
    setLang(code);
    close();
  };

  const themeRows: Array<{ mode: ThemeMode; icon: IconName; label: string }> = [
    { mode: 'dark', icon: 'moon', label: 'Dark' },
    { mode: 'light', icon: 'sun', label: 'Light' },
    { mode: 'system', icon: 'monitor', label: 'System' },
  ];

  return (
    <>
      <button
        ref={anchorRef}
        className="icon-btn"
        onClick={() => setOpen(!open)}
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="header-menu-trigger"
      >
        <Icon name="more-horizontal" size={18} />
      </button>

      {open &&
        portal(
          <div
            ref={menuRef}
            className="menu-panel"
            role="menu"
            aria-label="More options"
            data-testid="header-menu"
            style={style}
          >
            {/* Inline on a wide screen, so they would be duplicates there. `.only-phone`
                is a media query, not a JS breakpoint — no state to keep in sync. */}
            <button
              className="menu-item only-phone"
              role="menuitem"
              onClick={() => {
                close();
                onLock();
              }}
            >
              <Icon name="lock" size={18} />
              <span>Lock wallet</span>
            </button>
            <div className="menu-divider only-phone" />

            <div className="menu-section">Theme</div>
            {themeRows.map((row) => (
              <button
                key={row.mode}
                className={`menu-item ${mode === row.mode ? 'active' : ''}`}
                role="menuitemradio"
                aria-checked={mode === row.mode}
                onClick={() => pickTheme(row.mode)}
              >
                <Icon name={row.icon} size={18} />
                <span>{row.label}</span>
                {mode === row.mode && <Icon name="check" size={16} className="menu-item-note" />}
              </button>
            ))}

            <div className="menu-divider" />

            <div className="menu-section">Language</div>
            <button
              className="menu-item"
              onClick={() => setShowLangs(!showLangs)}
              aria-expanded={showLangs}
            >
              <Icon name="globe" size={18} />
              <span>{currentLanguage.name}</span>
              <Icon
                name={showLangs ? 'chevron-up' : 'chevron-down'}
                size={16}
                className="menu-item-note"
              />
            </button>
            {/* Expanded inline rather than in a nested popover: the menu is already a
                scrollable fixed layer, and a submenu inside it would be clipped by its
                own `overflow-y: auto`. */}
            {showLangs &&
              languages.map((l) => (
                <button
                  key={l.code}
                  className={`menu-item ${l.code === lang ? 'active' : ''}`}
                  role="menuitemradio"
                  aria-checked={l.code === lang}
                  onClick={() => pickLang(l.code)}
                  lang={l.code}
                >
                  {/* Flags stay as emoji: there is no honest 24px stroke icon for a
                      national flag, and every platform already renders these. */}
                  <span className="flag" aria-hidden="true">
                    {l.flag}
                  </span>
                  <span className="truncate">{l.name}</span>
                  {l.code === lang && <Icon name="check" size={16} className="menu-item-note" />}
                </button>
              ))}

            <div className="menu-divider" />

            <div className="menu-section">Status</div>
            <PvacRow status={pvacStatus} error={pvacError} />
            {rpcWarning && (
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  close();
                  onOpenSettings();
                }}
                title={rpcWarning}
              >
                <span className="status-dot warn" />
                <span className="truncate">Insecure RPC</span>
                <Icon name="chevron-right" size={16} className="menu-item-note" />
              </button>
            )}
          </div>,
        )}
    </>
  );
}

/**
 * PVAC (encrypted-balance WASM) health, as a row rather than a header tag.
 *
 * The dot repeats what the text says — it is never the only carrier of the state,
 * because ~8% of men cannot tell this red from this green.
 */
function PvacRow({ status, error }: { status: string; error?: string | null }) {
  const map: Record<string, { dot: string; label: string; title: string }> = {
    loading: { dot: 'idle', label: 'PVAC loading…', title: 'Loading the PVAC WASM module' },
    ready: { dot: 'ok', label: 'PVAC ready', title: 'PVAC WASM loaded and bridge initialized' },
    failed: { dot: 'err', label: 'PVAC failed', title: `PVAC failed: ${error ?? ''}` },
    unavailable: {
      dot: 'warn',
      label: 'PVAC unavailable',
      title: 'PVAC WASM not compiled — run npm run build:wasm to enable FHE operations',
    },
  };
  const row = map[status];
  if (!row) return null;
  return (
    <div className="menu-item" role="none" title={row.title} aria-live="polite">
      <span className={`status-dot ${row.dot}`} />
      <span className="truncate">{row.label}</span>
    </div>
  );
}
