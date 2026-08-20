import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { getHistory } from '../api/send';
import { formatAmount } from '../tx/builder';
import type { HistoryEntry } from '../rpc/client';
import { InfoHint } from './Tooltip';
import { PanelSkeleton } from './PanelSkeleton';
import { PageHead } from './PageHead';
import { Icon } from './icons';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { downloadCsv, exportFilename } from '../utils/csv';

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
        const next = page.transactions.map(normalizeEntry).filter((e) => !seen.has(e.key));
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
    return <PanelSkeleton title="Transaction History" message="Waiting for wallet…" rows={3} />;
  }

  /**
   * Export the rows currently loaded in the table.
   *
   * Deliberately not a fresh full-history fetch: what the user sees is what
   * they get, so a 20k-transaction account cannot turn a click into a very long
   * silent download. "Load more" first to widen the export.
   */
  const exportCsv = () => {
    if (!wallet || entries.length === 0) return;
    const rows: unknown[][] = [
      [
        'Time (ISO)',
        'Timestamp',
        'Hash',
        'Type',
        'From',
        'To',
        'Direction',
        'Amount (OCT)',
        'Fee (OCT)',
        'Status',
      ],
      ...entries.map((tx) => [
        tx.timestamp === null ? '' : new Date(tx.timestamp * 1000).toISOString(),
        tx.timestamp ?? '',
        tx.hash,
        tx.opType,
        tx.from,
        tx.recipient,
        tx.recipient === wallet.addr ? 'in' : tx.from === wallet.addr ? 'out' : '',
        tx.amount,
        tx.fee,
        tx.status,
      ]),
    ];
    downloadCsv(exportFilename('history', wallet.addr), rows);
    pushToast(
      'success',
      `Exported ${entries.length} transaction${entries.length === 1 ? '' : 's'} to CSV`,
    );
  };

  const showSkeleton = !hasLoadedOnce && entries.length === 0 && !error;

  /**
   * One row, derived once and consumed by both the phone list and the wide
   * table — the two layouts must never disagree about direction or sign.
   */
  const describe = (tx: SafeEntry) => {
    const incoming = tx.recipient === wallet.addr;
    const outgoing = tx.from === wallet.addr;
    return {
      incoming,
      outgoing,
      /** Self-transfers are both, so name them rather than guessing a direction. */
      self: incoming && outgoing,
      counterparty: incoming ? tx.from : tx.recipient,
    };
  };

  return (
    <div className="page">
      <PageHead
        icon="history"
        title="History"
        sub="Transfers, contract calls and stealth payments for the active account."
        actions={
          <>
            <button
              className="ghost btn-sm"
              onClick={exportCsv}
              title={
                entries.length === 0
                  ? 'Nothing to export yet'
                  : `Export the ${entries.length} loaded row${entries.length === 1 ? '' : 's'} as CSV`
              }
              aria-label="Export history as CSV"
              disabled={entries.length === 0 || panelLoading.loading}
            >
              <Icon name="download" size={14} /> Export CSV
            </button>
            <button
              className="icon-btn"
              onClick={refresh}
              title="Refresh"
              aria-label="Refresh"
              disabled={panelLoading.loading}
            >
              <Icon name="refresh" size={16} />
            </button>
          </>
        }
      />

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Icon name="history" size={18} /> Transaction History
            <InfoHint text="Recent transactions for this wallet. Shows incoming and outgoing transfers, contract calls, and stealth payments. Updates on page load — click refresh for latest." />
          </div>
          {lastUpdated && (
            <span className="card-meta">
              {usingCache ? (
                <>
                  <Icon name="alert-triangle" size={12} /> Cached
                </>
              ) : (
                `Updated ${lastUpdated.toLocaleTimeString()}`
              )}
            </span>
          )}
        </div>

        {showSkeleton ? (
          <div className="stack">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton row" />
            ))}
          </div>
        ) : error && entries.length === 0 ? (
          <div className="empty-state danger">
            <div className="icon">
              <Icon name="alert-triangle" size={28} />
            </div>
            <div className="title">Failed to load history</div>
            <div className="desc">{error}</div>
            <button className="ghost" onClick={refresh}>
              <Icon name="refresh" size={14} /> Retry
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <div className="icon">
              <Icon name="inbox" size={28} />
            </div>
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
              <div className="info-box warn spaced">
                <Icon name="alert-triangle" size={16} />
                <span>Showing cached data — network unavailable. Click refresh to retry.</span>
              </div>
            )}

            {/* Both layouts are rendered and CSS picks one at 768px
                (`.list-only-phone` / `.table-only-wide`), so there is no JS
                breakpoint to drift out of step with the stylesheet. The table is
                520px wide at minimum: on a 360px screen that is a sideways scroll
                which hides the amount column — the one thing History is opened to
                read. */}
            <div className="list-rows list-only-phone">
              {entries.map((tx) => {
                const d = describe(tx);
                return (
                  <div key={tx.key} className="list-row">
                    <span className={`list-mark ${d.incoming ? 'in' : 'out'}`}>
                      <Icon name={d.incoming ? 'arrow-down' : 'arrow-up'} size={16} />
                    </span>
                    <div className="list-main">
                      <div className="list-line">
                        <span className="list-title mono">
                          {d.self ? 'Self transfer' : shortenAddr(d.counterparty)}
                        </span>
                        <span className={`badge ${tx.status}`}>{tx.status}</span>
                      </div>
                      <div className="list-sub">
                        {tx.opType} · {formatTimestamp(tx.timestamp)} · fee {tx.fee}
                      </div>
                    </div>
                    <div className="list-side">
                      <span className={`list-amount ${d.incoming ? 'in' : 'out'}`}>
                        {d.incoming ? '+' : '−'}
                        {tx.amount}
                      </span>
                      <span className="list-sub mono" title={tx.hash}>
                        {shortenHash(tx.hash)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="table-scroll table-only-wide">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Hash</th>
                    <th>Type</th>
                    <th>From</th>
                    <th>To</th>
                    <th className="num">Amount</th>
                    <th className="num">Fee</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((tx) => {
                    const d = describe(tx);
                    return (
                      <tr key={tx.key}>
                        <td className="mono" title={tx.hash}>
                          {shortenHash(tx.hash)}
                        </td>
                        <td>
                          <span className="badge">{tx.opType}</span>
                        </td>
                        <td className="mono" title={tx.from}>
                          {d.outgoing ? <span className="tag ok">self</span> : shortenAddr(tx.from)}
                        </td>
                        <td className="mono" title={tx.recipient}>
                          {d.incoming ? (
                            <span className="tag ok">self</span>
                          ) : (
                            shortenAddr(tx.recipient)
                          )}
                        </td>
                        <td className={`mono num ${d.incoming ? 'pos' : ''}`}>
                          {d.incoming ? '+' : ''}
                          {tx.amount}
                        </td>
                        <td className="mono num muted">{tx.fee}</td>
                        <td>
                          <span className={`badge ${tx.status}`}>{tx.status}</span>
                        </td>
                        <td className="mono muted nowrap">{formatTimestamp(tx.timestamp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="list-footer">
              {hasMore && !usingCache && (
                <button className="ghost" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? (
                    <span className="spinner" />
                  ) : (
                    <>
                      <Icon name="arrow-down" size={14} /> Load more
                    </>
                  )}
                </button>
              )}
              <span className="list-count">
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
    </div>
  );
}
