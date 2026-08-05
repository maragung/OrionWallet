import { useState, useRef, useEffect, useCallback } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { listAccounts, unlockAccount } from '../api/wallet-api';
import type { ManifestEntry } from '../wallet/storage';
import { PinModal } from './PinModal';

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
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await listAccounts());
    } catch {
      // Non-fatal: the picker just shows the active account only.
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [wallet, refresh]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!wallet) return null;

  const active = accounts.find((a) => a.addr === wallet.addr);
  const activeLabel = active?.name || wallet.name || 'Account';

  const handleSwitch = (acct: ManifestEntry) => {
    setOpen(false);
    if (acct.addr === wallet.addr) return;
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
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          className="ghost account-picker-trigger"
          onClick={() => setOpen(!open)}
          title={wallet.addr}
          aria-label={`Account: ${activeLabel}`}
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
          <span style={{ fontSize: 14 }}>👤</span>
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

        {open && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              background: 'var(--bg-elevated-1)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--r-md)',
              boxShadow: 'var(--shadow-lg)',
              zIndex: 10000,
              minWidth: 260,
              maxHeight: 380,
              overflowY: 'auto',
              animation: 'slideUp var(--t-fast)',
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

            {accounts.length === 0 ? (
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
                    onClick={() => handleSwitch(a)}
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
          </div>
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
