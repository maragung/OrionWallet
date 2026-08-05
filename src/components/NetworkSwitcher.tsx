import { useState, useRef, useEffect } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useI18n } from '../i18n/useI18n';

type Network = 'devnet' | 'mainnet';

const PRESETS: Record<Network, { rpcUrl: string; explorerUrl: string; icon: string }> = {
  devnet: {
    rpcUrl: 'https://devnet.octrascan.io/rpc',
    explorerUrl: 'https://devnet.octrascan.io',
    icon: '🧪',
  },
  mainnet: {
    rpcUrl: 'https://octra.network/rpc',
    explorerUrl: 'https://octrascan.io',
    icon: '🚀',
  },
};

/**
 * Clickable network pill in the top bar.
 * Selecting a network applies it immediately — settings are persisted and the
 * RPC client is rebuilt by the store, so no save/refresh step is needed.
 */
export function NetworkSwitcher() {
  const { settings, setSettings, pushToast } = useWalletStore();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current: Network = settings?.network === 'mainnet' ? 'mainnet' : 'devnet';

  const select = async (network: Network) => {
    setOpen(false);
    if (!settings || network === current) return;
    const preset = PRESETS[network];
    try {
      // Persists + rebuilds the RPC client immediately.
      await setSettings({
        ...settings,
        network,
        rpcUrl: preset.rpcUrl,
        explorerUrl: preset.explorerUrl,
      });
      pushToast('success', `${t('network.switched')}: ${network.toUpperCase()}`);
    } catch (e) {
      pushToast('error', `${t('network.switchFailed')}: ${(e as Error).message}`);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="network-pill"
        onClick={() => setOpen(!open)}
        title={settings?.rpcUrl ?? ''}
        aria-label={`${t('network.label')}: ${current}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-1)',
          cursor: 'pointer',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span>{PRESETS[current].icon}</span>
        <span>{current.toUpperCase()}</span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: 'var(--bg-elevated-1)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 10000,
            minWidth: 260,
            overflow: 'hidden',
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
            {t('network.label')}
          </div>

          {(Object.keys(PRESETS) as Network[]).map((net) => {
            const isActive = net === current;
            return (
              <button
                key={net}
                className="ghost"
                onClick={() => select(net)}
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
                <span style={{ fontSize: 16 }}>{PRESETS[net].icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block' }}>{net.toUpperCase()}</span>
                  <span
                    className="mono"
                    style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                  >
                    {PRESETS[net].rpcUrl.replace(/^https?:\/\//, '')}
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
        </div>
      )}
    </div>
  );
}
