import { useState, useEffect, useCallback } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { listAccounts, unlockAccount, openWatchOnlyAccount } from '../api/wallet-api';
import type { ManifestEntry } from '../wallet/storage';
import { PinModal } from './PinModal';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { Icon } from './icons/Icon';

/**
 * Compact account switcher for the top bar.
 * Shows the active account name/address and lets the user switch between
 * accounts in the manifest. Full account management (derive/remove) lives
 * in Settings → Accounts.
 */
export function AccountPicker({ onManage }: { onManage?: () => void } = {}) {
  const { wallet, setWallet, pushToast } = useWalletStore();
  const panelLoading = usePanelLoading();
  const [accounts, setAccounts] = useState<ManifestEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<ManifestEntry | null>(null);
  /** Why the account list could not be read, if it could not. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  // Rendered in a top-level layer rather than inside the header row: the row clips
  // it away on phones (`overflow: hidden`), and inside the header's stacking
  // context a toast covered it and swallowed the click meant for a menu row.
  const {
    anchorRef,
    menuRef,
    style: menuStyle,
    portal,
  } = useAnchoredMenu<HTMLButtonElement>(open, {
    align: 'left',
    width: 280,
    maxHeight: 380,
    onDismiss: close,
  });

  const refresh = useCallback(async () => {
    try {
      setAccounts(await listAccounts());
      setLoadError(null);
    } catch (e) {
      // Leave whatever list we already have in place. Falling back to an empty
      // list would show "No accounts" for what is only a failed read, which
      // reads as "my accounts are gone".
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [wallet, refresh]);

  if (!wallet) return null;

  const active = accounts.find((a) => a.addr === wallet.addr);
  const activeLabel = active?.name || wallet.name || 'Account';

  const handleSwitch = async (acct: ManifestEntry) => {
    setOpen(false);
    if (acct.addr === wallet.addr) return;
    // Watch-only accounts have no keystore, so no PIN is involved.
    if (acct.watchOnly) {
      panelLoading.show('Switching account', `Loading ${acct.name}…`);
      try {
        setWallet(await openWatchOnlyAccount(acct.addr));
        pushToast('success', `Switched to ${acct.name} (watch-only)`);
        await refresh();
      } catch (e) {
        pushToast('error', `Switch failed: ${(e as Error).message}`);
      } finally {
        panelLoading.hide();
      }
      return;
    }
    setPendingSwitch(acct);
  };

  const confirmSwitch = async (enteredPin: string) => {
    const acct = pendingSwitch;
    if (!acct) return;
    panelLoading.show('Switching account', `Loading ${acct.name}…`);
    try {
      const w = await unlockAccount(acct.addr, enteredPin);
      setWallet(w);
      setPendingSwitch(null);
      pushToast('success', `Switched to ${w.name} (${w.addr.slice(0, 12)}…)`);
      await refresh();
    } catch (e) {
      pushToast('error', `Switch failed: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  return (
    <>
      {/* No wrapper element around the trigger. The menu is portalled out, so a
          wrapper's only effect was to sit between the button and the header's flex
          row as a `min-width: auto` item that refused to shrink — which is how the
          chip ended up 6px wider than the row and clipped on its left edge at 320px. */}
      <button
        ref={anchorRef}
        className="chip account-picker-trigger"
        onClick={() => setOpen(!open)}
        title={wallet.addr}
        aria-label={`Account: ${activeLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon
          name={wallet.watchOnly ? 'eye' : 'user'}
          size={14}
          label={wallet.watchOnly ? 'Watch-only account' : undefined}
        />
        <span className="chip-text">{activeLabel}</span>
        {/* The address hint disambiguates same-named accounts, but on a phone the
            name is already fighting the network chip for room — and the menu shows
            full addresses anyway. */}
        <span className="mono muted only-wide">{wallet.addr.slice(0, 6)}…</span>
        <Icon name="chevron-down" size={14} className="muted" />
      </button>

      {open &&
        portal(
          <div
            ref={menuRef}
            className="menu-panel"
            role="menu"
            aria-label="Accounts"
            data-testid="account-menu"
            style={menuStyle}
          >
            <div className="menu-section">Accounts</div>

            {loadError && (
              <div className="menu-error">
                <span>Could not read your accounts: {loadError}</span>
                <button className="ghost btn-sm" onClick={() => void refresh()}>
                  <Icon name="refresh" size={14} /> Try again
                </button>
              </div>
            )}

            {accounts.length === 0 && !loadError ? (
              <div className="menu-empty">No accounts in manifest.</div>
            ) : (
              accounts.map((a) => {
                const isActive = a.addr === wallet.addr;
                return (
                  <button
                    key={a.addr}
                    className={`menu-item two-line ${isActive ? 'active' : ''}`}
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => void handleSwitch(a)}
                    title={a.addr}
                  >
                    <span className="menu-item-main">
                      <span>
                        {a.name}
                        {a.watchOnly && (
                          <span className="tag warn" title="No keys — cannot sign">
                            <Icon name="eye" size={11} /> Watch
                          </span>
                        )}
                      </span>
                      <span className="menu-item-sub mono">
                        {a.addr.slice(0, 14)}…{a.addr.slice(-6)}
                      </span>
                    </span>
                    {isActive && <Icon name="check" size={16} />}
                  </button>
                );
              })
            )}

            {onManage && (
              <>
                <div className="menu-divider" />
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onManage();
                  }}
                >
                  <Icon name="settings" size={18} />
                  <span>Manage accounts</span>
                </button>
              </>
            )}
          </div>,
        )}

      <PinModal
        open={pendingSwitch !== null}
        title="Switch account"
        description={
          pendingSwitch
            ? `Enter your PIN to unlock "${pendingSwitch.name}" (${pendingSwitch.addr.slice(0, 12)}…). ` +
              'The signing keys must be decrypted before this account can become active.'
            : undefined
        }
        confirmLabel="Switch"
        busyLabel="Switching…"
        onSubmit={confirmSwitch}
        onCancel={() => setPendingSwitch(null)}
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
