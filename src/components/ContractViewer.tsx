import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { isValidAddress } from '../crypto/address';
import { JsonTreeView } from './JsonTreeView';
import { extractMethods } from '../tx/abi';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';

export function ContractViewer() {
  const { rpc, pushToast } = useWalletStore();
  const [addr, setAddr] = useState('');
  const [storageKey, setStorageKey] = useState('');
  const [info, setInfo] = useState<unknown>(null);
  const [methods, setMethods] = useState<string[]>([]);
  const [storage, setStorage] = useState<unknown>(null);
  const panelLoading = usePanelLoading();
  const { run } = panelLoading;
  const loading = panelLoading.loading;

  const lookup = async () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!isValidAddress(addr)) return pushToast('error', 'Invalid contract address');
    setInfo(null);
    setStorage(null);
    setMethods([]);
    await run(
      'Looking up contract',
      async () => {
        try {
          const infoR = await rpc.getProgramInfo(addr);
          if (infoR.ok) {
            setInfo(infoR.result);
            setMethods(extractMethods(infoR.result));
          } else {
            pushToast('warning', `Program info: ${infoR.error ?? 'not found'}`);
          }
        } catch (e) {
          pushToast('error', `Lookup failed: ${(e as Error).message}`);
        }
      },
      'Reading program info from the network…',
    );
  };

  const lookupStorage = async () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!isValidAddress(addr)) return pushToast('error', 'Invalid contract address');
    if (!storageKey.trim()) return pushToast('error', 'Storage key required');
    setStorage(null);
    await run(
      'Reading storage',
      async () => {
        try {
          const r = await rpc.getContractStorage(addr, storageKey.trim());
          if (r.ok) setStorage(r.result);
          else pushToast('warning', `Storage: ${r.error ?? 'not found'}`);
        } catch (e) {
          pushToast('error', `Storage lookup failed: ${(e as Error).message}`);
        }
      },
      'Fetching the requested storage key…',
    );
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">🔍 Contract Viewer</div>
      </div>

      <div className="form-row">
        <label htmlFor="caddr">Contract Address</label>
        <input
          id="caddr"
          className="mono"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="oct..."
          onKeyDown={(e) => e.key === 'Enter' && lookup()}
          style={addr && !isValidAddress(addr) ? { borderColor: 'var(--error)' } : undefined}
        />
      </div>

      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="primary" onClick={lookup} disabled={!addr || loading}>
          {loading ? <span className="spinner" /> : 'Look Up'}
        </button>
      </div>

      {info !== null && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div
            style={{
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-secondary)',
              fontWeight: 'var(--fw-semibold)',
              marginBottom: 'var(--sp-2)',
            }}
          >
            Program Info
          </div>
          <JsonTreeView data={info} />
          {methods.length > 0 && (
            <div
              style={{
                marginTop: 'var(--sp-3)',
                padding: 'var(--sp-3)',
                background: 'var(--bg-elevated-2)',
                borderRadius: 'var(--r-md)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
              }}
            >
              Detected {methods.length} callable method{methods.length === 1 ? '' : 's'}:{' '}
              <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                {methods.join(', ')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Storage reader — the node requires a specific key. */}
      <div style={{ marginTop: 'var(--sp-5)' }}>
        <div
          style={{
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-secondary)',
            fontWeight: 'var(--fw-semibold)',
            marginBottom: 'var(--sp-2)',
          }}
        >
          Read Storage
        </div>
        <div className="form-row">
          <label htmlFor="skey">Storage Key</label>
          <input
            id="skey"
            className="mono"
            value={storageKey}
            onChange={(e) => setStorageKey(e.target.value)}
            placeholder="e.g. symbol, name, total_supply"
            onKeyDown={(e) => e.key === 'Enter' && lookupStorage()}
          />
        </div>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button
            className="ghost"
            onClick={lookupStorage}
            disabled={!addr || !storageKey.trim() || !isValidAddress(addr)}
          >
            Read Key
          </button>
        </div>
        {storage !== null && (
          <div style={{ marginTop: 'var(--sp-2)' }}>
            <JsonTreeView data={storage} />
          </div>
        )}
      </div>

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
