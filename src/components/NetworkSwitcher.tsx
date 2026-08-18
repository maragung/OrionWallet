import { useCallback, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useI18n } from '../i18n/useI18n';
import { allNetworks, getNetworkDef, type NetworkDef, type NetworkId } from '../wallet/networks';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';

/**
 * Clickable network pill in the top bar.
 * Selecting a network applies it immediately — settings are persisted and the
 * RPC client is rebuilt by the store, so no save/refresh step is needed.
 * Lists both built-in presets and user-added custom networks.
 */
export function NetworkSwitcher() {
  const { settings, switchNetwork, pushToast } = useWalletStore();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // The menu lives in a top-level layer, not inside the header row: the row clips
  // it away on phones (`overflow: hidden`), and inside the header's stacking
  // context a toast covered it and swallowed the click meant for a menu row.
  const {
    anchorRef,
    menuRef,
    style: menuStyle,
    portal,
  } = useAnchoredMenu<HTMLButtonElement>(open, {
    align: 'right',
    width: 260,
    maxHeight: 340,
    onDismiss: close,
  });

  const networks = allNetworks(settings?.customNetworks);
  const currentId: NetworkId = settings?.network ?? 'devnet';
  const currentDef = getNetworkDef(currentId, settings?.customNetworks) ?? networks[0]!;

  const select = async (net: NetworkDef) => {
    setOpen(false);
    // Only skip when the active network is actually known. `currentId` falls back
    // to a default while settings are unloaded, and treating that guess as fact is
    // what made a tap here do nothing at all — the store resolves the real one.
    if (settings && net.id === settings.network) return;
    if (switching) return;
    setSwitching(true);
    try {
      // Persists + rebuilds the RPC client immediately.
      await switchNetwork(net);
      pushToast('success', `${t('network.switched')}: ${net.name}`);
    } catch (e) {
      pushToast('error', `${t('network.switchFailed')}: ${(e as Error).message}`);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div>
      <button
        ref={anchorRef}
        className="network-pill"
        onClick={() => setOpen(!open)}
        title={settings?.rpcUrl ?? ''}
        aria-label={`${t('network.label')}: ${currentDef.name}`}
        aria-busy={switching}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-1)',
          cursor: 'pointer',
          border: '1px solid var(--border-subtle)',
          opacity: switching ? 0.6 : 1,
        }}
      >
        <span>{currentDef.icon ?? '🌐'}</span>
        <span>{currentDef.name.toUpperCase()}</span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
      </button>

      {open &&
        portal(
          <div
            ref={menuRef}
            data-testid="network-menu"
            style={{
              background: 'var(--bg-elevated-1)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--r-md)',
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
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
              {t('network.label')}
            </div>

            {networks.map((net) => {
              const isActive = net.id === currentId;
              return (
                <button
                  key={net.id}
                  className="ghost"
                  onClick={() => void select(net)}
                  style={{
                    width: '100%',
                    justifyContent: 'flex-start',
                    gap: 'var(--sp-2)',
                    padding: 'var(--sp-2) var(--sp-3)',
                    minHeight: 44,
                    background: isActive ? 'var(--accent-soft)' : 'transparent',
                    color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                    fontWeight: isActive ? 'var(--fw-semibold)' : 'var(--fw-normal)',
                    borderRadius: 0,
                    borderBottom: '1px solid var(--border-subtle)',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 16 }}>{net.icon ?? '🌐'}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block' }}>{net.name.toUpperCase()}</span>
                    <span
                      className="mono"
                      style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                    >
                      {net.rpcUrl.replace(/^https?:\/\//, '')}
                    </span>
                  </span>
                  {isActive && <span style={{ color: 'var(--accent)' }}>✓</span>}
                </button>
              );
            })}

            <div
              style={{
                padding: 'var(--sp-2) var(--sp-3)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
              }}
            >
              {t('network.appliedInstantly')}
            </div>
          </div>,
        )}
    </div>
  );
}
