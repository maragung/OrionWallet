import { useCallback, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useI18n } from '../i18n/useI18n';
import { allNetworks, getNetworkDef, type NetworkDef, type NetworkId } from '../wallet/networks';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { Icon } from './icons/Icon';
import { networkIcon } from './icons/network-icon';

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
    <>
      <button
        ref={anchorRef}
        className="chip network-pill"
        onClick={() => setOpen(!open)}
        title={settings?.rpcUrl ?? ''}
        aria-label={`${t('network.label')}: ${currentDef.name}`}
        aria-haspopup="menu"
        aria-busy={switching}
        aria-expanded={open}
      >
        <Icon
          name={switching ? 'loader' : networkIcon(currentDef)}
          size={14}
          className={switching ? 'icon-spin' : undefined}
        />
        <span className="chip-text">{currentDef.name.toUpperCase()}</span>
        <Icon name="chevron-down" size={14} className="muted" />
      </button>

      {open &&
        portal(
          <div
            ref={menuRef}
            className="menu-panel"
            role="menu"
            aria-label={t('network.label')}
            data-testid="network-menu"
            style={menuStyle}
          >
            <div className="menu-section">{t('network.label')}</div>

            {networks.map((net) => {
              const isActive = net.id === currentId;
              return (
                <button
                  key={net.id}
                  className={`menu-item two-line ${isActive ? 'active' : ''}`}
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => void select(net)}
                  title={net.rpcUrl}
                >
                  <Icon name={networkIcon(net)} size={18} />
                  <span className="menu-item-main">
                    <span>{net.name.toUpperCase()}</span>
                    <span className="menu-item-sub mono">
                      {net.rpcUrl.replace(/^https?:\/\//, '')}
                    </span>
                  </span>
                  {isActive && <Icon name="check" size={16} />}
                </button>
              );
            })}

            <div className="menu-note">{t('network.appliedInstantly')}</div>
          </div>,
        )}
    </>
  );
}
