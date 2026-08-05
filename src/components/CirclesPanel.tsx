import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { PanelSkeleton } from './PanelSkeleton';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';

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
    <>
      <div className="card">
        <div className="card-header">
          <div className="card-title">Circles (Encrypted On-Chain Objects)</div>
          <button className="ghost" onClick={refresh} disabled={loading}>
            {loading ? <span className="spinner" /> : '↻ Refresh'}
          </button>
        </div>

        <div
          style={{
            marginBottom: 16,
            padding: 12,
            background: 'var(--bg-tertiary)',
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          <strong>What are Circles?</strong>
          <br />
          Circles are encrypted on-chain objects/assets backed by HFHE (Homomorphic Encryption).
          They enable private state, sealed slots, key-grant access control, and cross-circle
          relays.
          <br />
          <br />
          <span className="tag warn">⚠️ Requires PVAC WASM for full functionality</span>
        </div>

        {circles.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
            {loading ? 'Loading...' : 'No circles deployed by this wallet.'}
          </div>
        ) : (
          <div className="table-scroll">
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
                  <tr key={c.id} onClick={() => setSelectedCircle(c)} style={{ cursor: 'pointer' }}>
                    <td className="mono">{c.id.slice(0, 16)}…</td>
                    <td>
                      <span className="tag">{c.type}</span>
                    </td>
                    <td className="mono" style={{ color: 'var(--text-muted)' }}>
                      {new Date(c.created_at * 1000).toLocaleString()}
                    </td>
                    <td>
                      <button
                        className="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedCircle(c);
                        }}
                      >
                        View →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedCircle && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">Circle Details: {selectedCircle.id.slice(0, 16)}…</div>
            <button className="ghost" onClick={() => setSelectedCircle(null)}>
              Close
            </button>
          </div>
          <pre
            className="mono"
            style={{
              fontSize: 12,
              padding: 16,
              background: 'var(--bg-tertiary)',
              borderRadius: 8,
              overflowX: 'auto',
              color: 'var(--text-secondary)',
            }}
          >
            {JSON.stringify(selectedCircle, null, 2)}
          </pre>
        </div>
      )}

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
