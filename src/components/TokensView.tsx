import { useCallback, useEffect, useRef, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useI18n } from '../i18n/useI18n';
import { isValidAddress } from '../crypto/address';
import { PanelSkeleton } from './PanelSkeleton';
import { CopyButton } from './CopyButton';
import { Tooltip } from './Tooltip';
import { ConfirmDialog } from './ConfirmDialog';
import { TokenTransferForm } from './TokenTransferForm';
import {
  loadCachedHoldings,
  refreshHoldings,
  addTokenByAddress,
  removeToken,
  scanForTokens,
  compareHoldings,
  ScanCancelledError,
  type TokenHolding,
  type ScanProgress,
} from '../api/tokens';

/** Short form of a contract address for the card subtitle. */
function shortAddr(a: string): string {
  return a.length <= 20 ? a : `${a.slice(0, 10)}…${a.slice(-6)}`;
}

/** Up to two initials for the token monogram. */
function monogram(symbol: string | null): string {
  if (!symbol) return '?';
  const cleaned = symbol.replace(/[^A-Za-z0-9]/g, '');
  return (cleaned.slice(0, 2) || '?').toUpperCase();
}

export function TokensView() {
  const { wallet, rpc, pushToast } = useWalletStore();
  const { t } = useI18n();

  const [holdings, setHoldings] = useState<TokenHolding[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [addr, setAddr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<TokenHolding | null>(null);
  const [sending, setSending] = useState<TokenHolding | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Cancel an in-flight scan so it cannot keep hammering the node after
      // the panel is gone.
      abortRef.current?.abort();
    };
  }, []);

  // Load from cache immediately, then refresh known balances. A full scan is
  // never automatic — it costs thousands of requests.
  useEffect(() => {
    if (!wallet || !rpc) return;
    let cancelled = false;
    (async () => {
      const cached = await loadCachedHoldings(rpc.url, wallet.addr);
      if (cancelled || !mounted.current) return;
      setHoldings(cached);
      if (cached.length === 0) return;
      try {
        const fresh = await refreshHoldings(rpc, wallet.addr);
        if (!cancelled && mounted.current) setHoldings(fresh);
      } catch {
        // Keep the cached values; they are better than an empty list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet, rpc]);

  const doRefresh = useCallback(async () => {
    if (!wallet || !rpc) return;
    setBusy(true);
    setError(null);
    try {
      setHoldings(await refreshHoldings(rpc, wallet.addr));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [wallet, rpc]);

  const doAdd = useCallback(async () => {
    if (!wallet || !rpc) return;
    const contract = addr.trim();
    if (!isValidAddress(contract)) {
      pushToast('error', t('tokens.invalidAddress'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addTokenByAddress(rpc, wallet.addr, contract);
      setAddr('');
      setHoldings(await loadCachedHoldings(rpc.url, wallet.addr));
      pushToast('success', t('tokens.added'));
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      pushToast('error', msg);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [wallet, rpc, addr, pushToast, t]);

  const doScan = useCallback(async () => {
    if (!wallet || !rpc) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setScanning(true);
    setError(null);
    setProgress({ scanned: 0, total: 0, found: 0 });
    try {
      const found = await scanForTokens(rpc, wallet.addr, {
        signal: ac.signal,
        onProgress: (p) => {
          if (mounted.current) setProgress(p);
        },
        onHit: (holding) => {
          if (mounted.current) {
            setHoldings((prev) => {
              // De-dupe: a refresh might have already added this token.
              if (prev.some((h) => h.contract === holding.contract)) return prev;
              return [...prev, holding].sort(compareHoldings);
            });
          }
        },
      });
      if (!mounted.current) return;
      setHoldings(found);
      pushToast('success', t('tokens.scanDone').replace('{n}', String(found.length)));
    } catch (e) {
      if (e instanceof ScanCancelledError) {
        // Cancelling is a normal outcome, not a failure.
        if (mounted.current) pushToast('info', t('tokens.scanCancelled'));
        const partial = await loadCachedHoldings(rpc.url, wallet.addr);
        if (mounted.current) setHoldings(partial);
      } else {
        if (mounted.current) setError((e as Error).message);
      }
    } finally {
      if (mounted.current) {
        setScanning(false);
        setProgress(null);
      }
      abortRef.current = null;
    }
  }, [wallet, rpc, pushToast, t]);

  const doRemove = useCallback(async () => {
    if (!wallet || !rpc || !confirmRemove) return;
    const target = confirmRemove;
    setConfirmRemove(null);
    await removeToken(rpc.url, wallet.addr, target.contract);
    setHoldings(await loadCachedHoldings(rpc.url, wallet.addr));
  }, [wallet, rpc, confirmRemove]);

  if (!wallet || !rpc) return <PanelSkeleton title={t('tokens.title')} rows={3} />;

  const pct =
    progress && progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            💎 {t('tokens.title')}{' '}
            <Tooltip text={t('tokens.tooltip')}>
              <span
                style={{ color: 'var(--text-muted)', cursor: 'help', fontSize: 'var(--fs-sm)' }}
              >
                ⓘ
              </span>
            </Tooltip>
          </div>
          <button
            className="ghost icon"
            onClick={doRefresh}
            title={t('common.refresh')}
            disabled={busy || scanning || holdings.length === 0}
          >
            ↻
          </button>
        </div>

        {/* Manual add — instant, unlike a scan. */}
        <div className="form-row">
          <label htmlFor="tokenAddr">{t('tokens.addLabel')}</label>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <input
              id="tokenAddr"
              className="mono"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="oct…"
              onKeyDown={(e) => e.key === 'Enter' && doAdd()}
              disabled={busy || scanning}
              style={
                addr && !isValidAddress(addr.trim()) ? { borderColor: 'var(--error)' } : undefined
              }
            />
            <button className="primary" onClick={doAdd} disabled={busy || scanning || !addr.trim()}>
              {t('tokens.add')}
            </button>
          </div>
        </div>

        {/* Opt-in scan. Deliberately explicit about the cost. */}
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
          {t('tokens.scanExplainer')}
          <div
            style={{
              marginTop: 'var(--sp-2)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sp-2)',
            }}
          >
            {scanning ? (
              <>
                <span className="spinner" />
                <span className="mono">
                  {progress ? `${progress.scanned}/${progress.total} (${pct}%)` : '…'}
                </span>
                <span>{t('tokens.scanFound').replace('{n}', String(progress?.found ?? 0))}</span>
                <button className="ghost" onClick={() => abortRef.current?.abort()}>
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <button className="ghost" onClick={doScan} disabled={busy}>
                🔍 {t('tokens.scan')}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div
            style={{
              marginTop: 'var(--sp-3)',
              color: 'var(--error)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            ⚠️ {error}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">{t('tokens.holdings')}</div>
          {holdings.length > 0 && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              {holdings.length}
            </span>
          )}
        </div>

        {holdings.length === 0 ? (
          <div className="empty-state">
            <div className="icon">💎</div>
            <div className="title">{t('tokens.emptyTitle')}</div>
            <div className="desc">{t('tokens.emptyDesc')}</div>
          </div>
        ) : (
          <div className="token-list">
            {holdings.map((h) => (
              <div className="token-card" key={h.contract}>
                <div className="token-mark" aria-hidden="true">
                  {monogram(h.symbol)}
                </div>

                <div className="token-main">
                  <div className="token-line">
                    <span className="token-symbol">{h.symbol ?? t('tokens.unknownSymbol')}</span>
                    {h.custom && <span className="tag info">{t('tokens.manual')}</span>}
                    {h.amount.unscaled && (
                      <Tooltip text={t('tokens.unscaledHint')}>
                        <span className="tag warn">{t('tokens.incomplete')}</span>
                      </Tooltip>
                    )}
                  </div>
                  <div className="token-name">{h.name ?? '—'}</div>
                  <div className="token-addr">
                    {/* Address is the real identity — symbols are not unique
                        and can be spoofed, so it stays visible. */}
                    <span className="mono" title={h.contract}>
                      {shortAddr(h.contract)}
                    </span>
                    <CopyButton
                      value={h.contract}
                      className="ghost icon"
                      title={t('common.copy')}
                    />
                  </div>
                </div>

                <div className="token-side">
                  <div
                    className="token-balance mono"
                    // Full precision on hover; the display value is truncated.
                    title={`${h.amount.exact}${h.amount.unscaled ? ` (${t('tokens.rawUnits')})` : ''}`}
                  >
                    {h.amount.display}
                    {h.amount.unscaled && (
                      <span className="token-raw-suffix"> {t('tokens.rawUnits')}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--sp-1)' }}>
                    <button
                      className="ghost"
                      onClick={() => setSending(h)}
                      // Without decimals the amount cannot be scaled safely, so
                      // sending is blocked rather than risking a wrong amount.
                      disabled={h.raw === 0n || h.decimals === null}
                      title={h.decimals === null ? t('tokenTx.unknownDecimals') : undefined}
                    >
                      {t('tokenTx.send')}
                    </button>
                    <button className="ghost" onClick={() => setConfirmRemove(h)}>
                      {t('tokens.remove')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            marginTop: 'var(--sp-3)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-muted)',
          }}
        >
          ⚠️ {t('tokens.spoofWarning')}
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove !== null}
        title={t('tokens.removeTitle')}
        message={t('tokens.removeConfirm').replace(
          '{symbol}',
          confirmRemove?.symbol ?? confirmRemove?.contract ?? '',
        )}
        confirmLabel={t('tokens.remove')}
        onConfirm={doRemove}
        onCancel={() => setConfirmRemove(null)}
      />

      {sending && (
        <TokenTransferForm
          token={sending}
          onClose={() => setSending(null)}
          onDone={() => {
            setSending(null);
            // Balance changes only once the tx confirms, so re-read rather
            // than optimistically subtracting.
            void doRefresh();
          }}
        />
      )}
    </>
  );
}
