import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { isValidAddress } from '../crypto/address';
import { JsonTreeView } from './JsonTreeView';
import { extractMethods } from '../tx/abi';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { PageHead } from './PageHead';
import { Icon } from './icons/Icon';

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

  const addrInvalid = Boolean(addr.trim()) && !isValidAddress(addr.trim());

  return (
    <div className="page">
      <PageHead
        icon="search"
        title="Contract Viewer"
        sub="Read a deployed contract's program info, its callable methods, and any storage key by name."
      />

      <div className="card">
        <div className="form-row">
          <label htmlFor="caddr">Contract Address</label>
          <input
            id="caddr"
            className="mono"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="oct..."
            onKeyDown={(e) => e.key === 'Enter' && lookup()}
            aria-invalid={addrInvalid}
            data-invalid={addrInvalid ? 'true' : undefined}
          />
        </div>

        <div className="form-actions start">
          <button className="primary" onClick={lookup} disabled={!addr || loading}>
            {loading ? (
              <>
                <Icon name="loader" size={18} className="icon-spin" /> Look Up
              </>
            ) : (
              <>
                <Icon name="search" size={18} /> Look Up
              </>
            )}
          </button>
        </div>

        {info !== null && (
          <div className="stack-section">
            <div className="card-subhead">
              <Icon name="file-text" size={16} /> Program Info
            </div>
            <JsonTreeView data={info} />
            {methods.length > 0 && (
              <div className="info-box spaced-top">
                <Icon name="info" size={18} />
                <div className="info-box-body">
                  <span>
                    Detected {methods.length} callable method{methods.length === 1 ? '' : 's'}:{' '}
                    <span className="mono">{methods.join(', ')}</span>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Storage reader — the node requires a specific key. */}
        <div>
          <div className="card-subhead">
            <Icon name="key" size={16} /> Read Storage
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
          <div className="form-actions start">
            <button
              className="ghost"
              onClick={lookupStorage}
              disabled={!addr || !storageKey.trim() || !isValidAddress(addr)}
            >
              <Icon name="download" size={16} /> Read Key
            </button>
          </div>
          {storage !== null && (
            <div className="spaced-top">
              <JsonTreeView data={storage} />
            </div>
          )}
        </div>
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
