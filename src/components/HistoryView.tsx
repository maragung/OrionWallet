import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { getHistory } from '../api/send';
import { formatAmount } from '../tx/builder';
import type { HistoryEntry } from '../rpc/client';
import { Tooltip } from './Tooltip';
import { PanelSkeleton } from './PanelSkeleton';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';

/**
 * A history row that is safe to render.
 *
 * Neither the node response nor the local tx cache is schema-validated, and the
 * cache path casts blindly (`c.tx as HistoryEntry`). A missing `hash` or a
 * numeric `amount` used to throw mid-render, which unmounts the entire React
 * tree and leaves the blank "Loading Orion Wallet…" fallback from index.html.
 * Normalising up-front keeps every field render-safe.
 */
interface SafeEntry {
  key: string;
  hash: string;
  from: string;
  recipient: string;
  amount: string;
  fee: string;
  opType: string;
  status: string;
  timestamp: number | null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeEntry(raw: unknown, index: number): SafeEntry {
  const tx = (raw ?? {}) as Partial<HistoryEntry>;
  const hash = asString(tx.hash);
  const rawTs = typeof tx.timestamp === 'number' ? tx.timestamp : Number(tx.timestamp);
  return {
    key: hash || `entry-${index}`,
    hash,
    from: asString(tx.from),
    recipient: asString(tx.to_ ?? tx.to),
    amount: formatAmount(tx.amount),
    fee: formatAmount(tx.ou),
    opType: asString(tx.op_type) || 'unknown',
    status: asString(tx.status) || 'pending',
    timestamp: Number.isFinite(rawTs) && rawTs > 0 ? rawTs : null,
  };
}

function shortenHash(hash: string): string {
  if (!hash) return '—';
  return hash.length > 10 ? `${hash.slice(0, 10)}…` : hash;
}

function shortenAddr(addr: string): string {
  if (!addr) return '—';
  return addr.length > 8 ? `${addr.slice(0, 8)}…` : addr;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) return '—';
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** How many rows to request per page. */
const PAGE_SIZE = 50;

export function HistoryView() {
  const { wallet, rpc, pushToast } = useWalletStore();
  const [entries, setEntries] = useState<SafeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usingCache, setUsingCache] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const panelLoading = usePanelLoading();
  const { run, isMounted } = panelLoading;

  const refresh = async () => {
    if (!wallet || !rpc) return;
    setError(null);
    setUsingCache(false);
    try {
      await run(
        'Loading history',
        async () => {
          try {
            const page = await getHistory(rpc, wallet.addr, {
              limit: PAGE_SIZE,
              offset: 0,
              useCache: true,
            });
            if (!isMounted()) return;
            setEntries(page.transactions.map(normalizeEntry));
            setTotal(page.total);
            setHasMore(page.hasMore);
            setLastUpdated(new Date());
          } catch (e) {
            const msg = (e as Error).message;
            if (!isMounted()) return;
            setError(msg);
            setHasMore(false);
            try {
              const { listTxCache } = await import('../wallet/storage');
              const cached = await listTxCache(wallet.addr, PAGE_SIZE);
              if (!isMounted()) return;
              if (cached.length > 0) {
                setEntries(cached.map((c, i) => normalizeEntry(c.tx, i)));
                setTotal(cached.length);
                setUsingCache(true);
                pushToast('warning', 'Showing cached transactions (network unavailable)');
              }
            } catch {
              // no cache available
            }
          }
        },
        'Fetching recent transactions from the network…',
      );
    } finally {
      if (isMounted()) setHasLoadedOnce(true);
    }
  };

  const loadMore = async () => {
    if (!wallet || !rpc || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getHistory(rpc, wallet.addr, {
        limit: PAGE_SIZE,
        offset: entries.length,
        useCache: false,
      });
      if (!isMounted()) return;
      // De-dupe by hash: a new tx arriving between pages can shift the window
      // and re-surface a row we already show.
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.key));
        const next = page.transactions
          .map(normalizeEntry)
          .filter((e) => !seen.has(e.key));
        return [...prev, ...next];
      });
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (e) {
      if (isMounted()) pushToast('error', `Failed to load more: ${(e as Error).message}`);
    } finally {
      if (isMounted()) setLoadingMore(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, rpc]);

  // Render a titled skeleton rather than `null` while prerequisites resolve —
  // returning null here leaves the main content area completely empty.
  if (!wallet) {
    return <PanelSkeleton title="📜 Transaction History" message="Waiting for wallet…" rows={3} />;
  }

  const showSkeleton = !hasLoadedOnce && entries.length === 0 && !error;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            📜 Transaction History{' '}
            <Tooltip text="Recent transactions for this wallet. Shows incoming and outgoing transfers, contract calls, and stealth payments. Updates on page load — click refresh for latest.">
              <span
                style={{ color: 'var(--text-muted)', cursor: 'help', fontSize: 'var(--fs-sm)' }}
              >
                ⓘ
              </span>
            </Tooltip>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            {lastUpdated && (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                {usingCache ? '⚠ Cached' : `Updated ${lastUpdated.toLocaleTimeString()}`}
              </span>
            )}
            <button
              className="ghost icon"
              onClick={refresh}
              title="Refresh"
              disabled={panelLoading.loading}
            >
              ↻
            </button>
          </div>
        </div>

        {showSkeleton ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 36 }} />
            ))}
          </div>
        ) : error && entries.length === 0 ? (
          <div className="empty-state" style={{ padding: 'var(--sp-8)', color: 'var(--error)' }}>
            <div className="icon">⚠️</div>
            <div className="title">Failed to load history</div>
            <div className="desc">{error}</div>
            <button className="ghost" style={{ marginTop: 'var(--sp-3)' }} onClick={refresh}>
              ↻ Retry
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <div className="title">No transactions yet</div>
            <div className="desc">
              Your transaction history will appear here once you send or receive OCT.
              <br />
              New transactions typically appear within a few seconds after submission.
            </div>
          </div>
        ) : (
          <>
            {usingCache && (
              <div
                className="info-box warn"
                style={{
                  marginBottom: 'var(--sp-3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-2)',
                }}
              >
                <span>⚠️</span>
                <span>Showing cached data — network unavailable. Click refresh to retry.</span>
              </div>
            )}
            <div className="table-scroll" style={{ overflowX: 'auto' }}>
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Hash</th>
                    <th>Type</th>
                    <th>From</th>
                    <th>To</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th style={{ textAlign: 'right' }}>Fee</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((tx) => {
                    const isIncoming = tx.recipient === wallet.addr;
                    const isOutgoing = tx.from === wallet.addr;
                    return (
                      <tr key={tx.key}>
                        <td className="mono" title={tx.hash}>
                          {shortenHash(tx.hash)}
                        </td>
                        <td>
                          <span className="badge">{tx.opType}</span>
                        </td>
                        <td className="mono" title={tx.from}>
                          {isOutgoing ? <span className="tag ok">self</span> : shortenAddr(tx.from)}
                        </td>
                        <td className="mono" title={tx.recipient}>
                          {isIncoming ? (
                            <span className="tag ok">self</span>
                          ) : (
                            shortenAddr(tx.recipient)
                          )}
                        </td>
                        <td
                          className="mono"
                          style={{
                            textAlign: 'right',
                            color: isIncoming ? 'var(--success)' : 'inherit',
                          }}
                        >
                          {isIncoming ? '+' : ''}
                          {tx.amount}
                        </td>
                        <td
                          className="mono"
                          style={{ textAlign: 'right', color: 'var(--text-muted)' }}
                        >
                          {tx.fee}
                        </td>
                        <td>
                          <span className={`badge ${tx.status}`}>{tx.status}</span>
                        </td>
                        <td
                          className="mono"
                          style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
                        >
                          {formatTimestamp(tx.timestamp)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div
              style={{
                marginTop: 'var(--sp-3)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--sp-2)',
              }}
            >
              {hasMore && !usingCache && (
                <button
                  className="ghost"
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{ minWidth: 140 }}
                >
                  {loadingMore ? <span className="spinner" /> : '↓ Load more'}
                </button>
              )}
              <span
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                }}
              >
                Showing {entries.length}
                {total > entries.length ? ` of ${total}` : ''} transaction
                {entries.length === 1 ? '' : 's'}
              </span>
            </div>
          </>
        )}
      </div>

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
