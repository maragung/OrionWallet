import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { PanelSkeleton } from './PanelSkeleton';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { JsonTreeView } from './JsonTreeView';
import { PageHead } from './PageHead';
import { Icon } from './icons/Icon';

interface CircleInfo {
  id: string;
  addr: string;
  type: string;
  created_at: number;
  program?: unknown;
}

export function CirclesPanel() {
  const { wallet, rpc, pushToast } = useWalletStore();
  const [circles, setCircles] = useState<CircleInfo[]>([]);
  const [selectedCircle, setSelectedCircle] = useState<CircleInfo | null>(null);
  const panelLoading = usePanelLoading();
  const { run, isMounted } = panelLoading;
  const loading = panelLoading.loading;

  const refresh = async () => {
    if (!wallet || !rpc) return;
    await run(
      'Fetching circles',
      async () => {
        // Try to get circles info for this address
        const r = await rpc.rpcCall<CircleInfo[]>('octra_circleInfo', [wallet.addr]);
        if (!isMounted()) return;
        if (r.ok && r.result) {
          setCircles(Array.isArray(r.result) ? r.result : []);
        } else if (!r.ok) {
          const errLower = (r.error ?? '').toLowerCase();
          // "not found" means no circles for this address — treat as empty, not an error.
          if (!errLower.includes('not found') && r.status !== 404) {
            pushToast('error', `Failed to fetch circles: ${r.error ?? 'unknown'}`);
          }
        }
      },
      'Reading encrypted on-chain objects…',
    );
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, rpc]);

  if (!wallet) return <PanelSkeleton title="Circles" rows={2} />;

  return (
    <div className="page">
      <PageHead
        icon="circle-dot"
        title="Circles"
        sub="Encrypted on-chain objects backed by homomorphic encryption."
        actions={
          <button className="ghost" onClick={refresh} disabled={loading}>
            <Icon
              name={loading ? 'loader' : 'refresh'}
              size={16}
              className={loading ? 'icon-spin' : undefined}
            />{' '}
            Refresh
          </button>
        }
      />

      <div className="card">
        <div className="info-box spaced">
          <Icon name="info" size={18} />
          <div className="info-box-body">
            <strong>What are Circles?</strong>
            <span>
              Circles are encrypted on-chain objects/assets backed by HFHE (Homomorphic Encryption).
              They enable private state, sealed slots, key-grant access control, and cross-circle
              relays.
            </span>
          </div>
        </div>

        <div className="info-box warn spaced">
          <Icon name="alert-triangle" size={18} />
          <div className="info-box-body">Requires PVAC WASM for full functionality</div>
        </div>

        {circles.length === 0 ? (
          <div className="empty-state compact">
            <div className="icon">
              <Icon name="circle-dot" size={28} />
            </div>
            <div className="title">{loading ? 'Loading circles…' : 'No circles yet'}</div>
            <div className="desc">
              {loading
                ? 'Reading encrypted on-chain objects for this address.'
                : 'No circles deployed by this wallet.'}
            </div>
          </div>
        ) : (
          <>
            {/* Phones get rows, wider screens get the table. Both are rendered and
                one is hidden per breakpoint, so there is no JS width to drift. */}
            <div className="list-rows list-only-phone">
              {circles.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="list-row interactive"
                  onClick={() => setSelectedCircle(c)}
                >
                  <div className="list-mark">
                    <Icon name="circle-dot" size={16} />
                  </div>
                  <div className="list-main">
                    <div className="list-line">
                      <span className="list-title mono">{c.id.slice(0, 16)}…</span>
                      <span className="tag">{c.type}</span>
                    </div>
                    <div className="list-sub">{new Date(c.created_at * 1000).toLocaleString()}</div>
                  </div>
                  <Icon name="chevron-right" size={16} />
                </button>
              ))}
            </div>

            <div className="table-scroll table-only-wide">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Type</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {circles.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id.slice(0, 16)}…</td>
                      <td>
                        <span className="tag">{c.type}</span>
                      </td>
                      <td className="mono muted">
                        {new Date(c.created_at * 1000).toLocaleString()}
                      </td>
                      <td>
                        <button
                          className="ghost btn-sm"
                          onClick={() => setSelectedCircle(c)}
                          aria-label={`View circle ${c.id.slice(0, 16)}`}
                        >
                          View <Icon name="chevron-right" size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {selectedCircle && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Icon name="circle-dot" size={18} /> Circle Details:{' '}
              <span className="mono">{selectedCircle.id.slice(0, 16)}…</span>
            </div>
            <button
              className="icon-btn"
              onClick={() => setSelectedCircle(null)}
              aria-label="Close circle details"
              title="Close"
            >
              <Icon name="x" size={18} />
            </button>
          </div>
          {/* The tree, not a raw `<pre>`: a circle carries a nested program object,
              and the flat blob was unreadable past the first few keys. */}
          <JsonTreeView data={selectedCircle} />
        </div>
      )}

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
