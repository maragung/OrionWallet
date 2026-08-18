import { useState, useEffect, useCallback } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { listAccounts, unlockAccount, openWatchOnlyAccount } from '../api/wallet-api';
import type { ManifestEntry } from '../wallet/storage';
import { PinModal } from './PinModal';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';

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
      <div>
        <button
          ref={anchorRef}
          className="ghost account-picker-trigger"
          onClick={() => setOpen(!open)}
          title={wallet.addr}
          aria-label={`Account: ${activeLabel}`}
          aria-expanded={open}
          style={{
            minHeight: 32,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            padding: 'var(--sp-1) var(--sp-3)',
            borderRadius: 'var(--r-full)',
            background: 'var(--bg-elevated-3)',
            fontSize: 'var(--fs-xs)',
            maxWidth: 200,
          }}
        >
          <span
            style={{ fontSize: 14 }}
            title={wallet.watchOnly ? 'Watch-only account' : undefined}
          >
            {wallet.watchOnly ? '👁' : '👤'}
          </span>
          <span
            style={{
              fontWeight: 'var(--fw-semibold)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {activeLabel}
          </span>
          <span className="mono" style={{ color: 'var(--text-muted)' }}>
            {wallet.addr.slice(0, 6)}…
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>▾</span>
        </button>

        {open &&
          portal(
            <div
              ref={menuRef}
              data-testid="account-menu"
              style={{
                background: 'var(--bg-elevated-1)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--r-md)',
                boxShadow: 'var(--shadow-lg)',
                animation: 'slideUp var(--t-fast)',
                ...menuStyle,
              }}
            >
              <div
                style={{
                  padding: 'var(--sp-2) var(--sp-3)',
                  fontSize: 'var(--fs-xs)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  color: 'var(--text-muted)',
                  fontWeight: 'var(--fw-semibold)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                Accounts
              </div>

              {loadError && (
                <div
                  style={{
                    padding: 'var(--sp-3)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--error)',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  Could not read your accounts: {loadError}
                  <button
                    className="ghost"
                    onClick={() => void refresh()}
                    style={{ marginTop: 'var(--sp-2)', minHeight: 28, fontSize: 'var(--fs-xs)' }}
                  >
                    ↻ Try again
                  </button>
                </div>
              )}

              {accounts.length === 0 && !loadError ? (
                <div
                  style={{
                    padding: 'var(--sp-3)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--text-muted)',
                  }}
                >
                  No accounts in manifest.
                </div>
              ) : (
                accounts.map((a) => {
                  const isActive = a.addr === wallet.addr;
                  return (
                    <button
                      key={a.addr}
                      className="ghost"
                      onClick={() => void handleSwitch(a)}
                      title={a.addr}
                      style={{
                        width: '100%',
                        justifyContent: 'flex-start',
                        gap: 'var(--sp-2)',
                        padding: 'var(--sp-2) var(--sp-3)',
                        minHeight: 40,
                        background: isActive ? 'var(--accent-soft)' : 'transparent',
                        color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                        fontWeight: isActive ? 'var(--fw-semibold)' : 'var(--fw-normal)',
                        borderRadius: 0,
                        borderBottom: '1px solid var(--border-subtle)',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {a.name}
                          {a.watchOnly && (
                            <span
                              className="tag warn"
                              style={{ marginLeft: 6, fontSize: 10 }}
                              title="No keys — cannot sign"
                            >
                              👁
                            </span>
                          )}
                        </span>
                        <span
                          className="mono"
                          style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                        >
                          {a.addr.slice(0, 14)}…{a.addr.slice(-6)}
                        </span>
                      </span>
                      {isActive && <span style={{ color: 'var(--accent)' }}>✓</span>}
                    </button>
                  );
                })
              )}

              {onManage && (
                <button
                  className="ghost"
                  onClick={() => {
                    setOpen(false);
                    onManage();
                  }}
                  style={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    gap: 'var(--sp-2)',
                    padding: 'var(--sp-2) var(--sp-3)',
                    minHeight: 36,
                    borderRadius: 0,
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  ⚙️ Manage accounts
                </button>
              )}
            </div>,
          )}
      </div>

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
