import { useCallback, useEffect, useRef, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useI18n } from '../i18n/useI18n';
import { isValidAddress } from '../crypto/address';
import { activeNetworkInfo } from '../wallet/networks';
import { PanelSkeleton } from './PanelSkeleton';
import { CopyButton } from './CopyButton';
import { Tooltip, InfoHint } from './Tooltip';
import { PageHead } from './PageHead';
import { Icon } from './icons';
import { ConfirmDialog } from './ConfirmDialog';
import { TokenTransferForm } from './TokenTransferForm';
import {
  loadCachedHoldings,
  refreshHoldings,
  addTokenByAddress,
  removeToken,
  discoverTokens,
  isDiscoveryDue,
  compareHoldings,
  ScanCancelledError,
  type DiscoveryResult,
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

/**
 * What the panel is currently doing.
 *
 * `refreshing` re-reads the balances of tokens already known (one batch);
 * `discovering` is the full sweep that finds tokens nobody told us about.
 * They are distinct because only the second one is worth a progress bar.
 */
type Phase = 'idle' | 'refreshing' | 'discovering';

/**
 * Outcome of a sweep, as the UI needs to see it.
 *
 * Cancelling is not a failure and must not raise an error, but it must not be
 * reported as a completed scan either — hence a union rather than a nullable
 * result.
 */
type DiscoverOutcome =
  | { kind: 'done'; result: DiscoveryResult }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'skipped' };

/** Insert or replace a token in a sorted list, keeping the order stable. */
function upsertHolding(list: TokenHolding[], next: TokenHolding): TokenHolding[] {
  const at = list.findIndex((h) => h.contract === next.contract);
  if (at >= 0) {
    // A refresh may have already added this contract; take the newer read.
    const copy = list.slice();
    copy[at] = next;
    return copy;
  }
  return [...list, next].sort(compareHoldings);
}

export function TokensView() {
  const { wallet, rpc, settings, pushToast } = useWalletStore();
  const { t } = useI18n();

  const [holdings, setHoldings] = useState<TokenHolding[]>([]);
  /** False until the cached list for this (network, address) has been read. */
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  /** Contracts the last sweep could not read, so the list may be incomplete. */
  const [unreadable, setUnreadable] = useState(0);
  const [busy, setBusy] = useState(false);
  const [addr, setAddr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<TokenHolding | null>(null);
  const [sending, setSending] = useState<TokenHolding | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  // The list always belongs to one network — say which, so a Devnet balance is
  // never mistaken for a Mainnet one.
  const networkName = activeNetworkInfo(
    settings?.network ?? 'devnet',
    settings?.customNetworks,
  ).name;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Cancel an in-flight sweep so it cannot keep hammering the node after
      // the panel is gone.
      abortRef.current?.abort();
    };
  }, []);

  /**
   * Run a full sweep for the active address and endpoint.
   *
   * Deliberately depends on `wallet` and `rpc` ONLY. Adding `t` or `pushToast`
   * would make the identity change whenever the language does, and the mount
   * effect below would restart a ~30 second sweep on every language switch.
   */
  const discover = useCallback(
    async (ac: AbortController, opts: { force?: boolean } = {}): Promise<DiscoverOutcome> => {
      const w = wallet;
      const r = rpc;
      if (!w || !r) return { kind: 'skipped' };
      abortRef.current = ac;
      setPhase('discovering');
      setError(null);
      setProgress({ scanned: 0, total: 0, found: 0 });
      try {
        const result = await discoverTokens(r, w.addr, {
          signal: ac.signal,
          force: opts.force,
          onProgress: (p) => {
            if (mounted.current) setProgress(p);
          },
          onHit: (h) => {
            // Stream hits in as they resolve rather than waiting for the whole
            // sweep; on devnet that is the difference between a list that fills
            // in and half a minute of nothing.
            if (mounted.current) setHoldings((prev) => upsertHolding(prev, h));
          },
        });
        if (!mounted.current) return { kind: 'skipped' };
        setHoldings(result.holdings);
        setUnreadable(result.unreadable);
        return { kind: 'done', result };
      } catch (e) {
        if (e instanceof ScanCancelledError) {
          // Whatever was found before the cancel is already on screen via
          // `onHit`, and re-reading the cache here could belong to the network
          // we just switched away from.
          return { kind: 'cancelled' };
        }
        if (mounted.current) setError((e as Error).message);
        return { kind: 'error', message: (e as Error).message };
      } finally {
        // Only the newest sweep owns the phase: a sweep aborted by a network
        // switch must not clear the state its replacement just set.
        if (abortRef.current === ac) {
          abortRef.current = null;
          if (mounted.current) {
            setPhase('idle');
            setProgress(null);
          }
        }
      }
    },
    [wallet, rpc],
  );

  // Everything reacts to (wallet, rpc): the store builds a NEW RpcClient on
  // every network switch, so changing network or account re-runs this from
  // scratch — cached list, balance refresh, then a sweep when one is due.
  useEffect(() => {
    if (!wallet || !rpc) return;
    const url = rpc.url;
    const owner = wallet.addr;
    const ac = new AbortController();
    let cancelled = false;
    // Drop the previous network's list immediately; showing it under the new
    // network's heading would be worse than showing nothing.
    setLoaded(false);
    setHoldings([]);
    setUnreadable(0);
    setError(null);
    (async () => {
      const cached = await loadCachedHoldings(url, owner);
      if (cancelled || !mounted.current) return;
      setHoldings(cached);
      setLoaded(true);
      if (cached.length > 0) {
        // One batch, so this runs on every visit: it is the only way a balance
        // changed elsewhere (or by the transfer we just sent) shows up here.
        setPhase('refreshing');
        try {
          const fresh = await refreshHoldings(rpc, owner);
          if (!cancelled && mounted.current) setHoldings(fresh);
        } catch {
          // Keep the cached values; they are better than an empty list.
        } finally {
          if (!cancelled && mounted.current && abortRef.current === null) setPhase('idle');
        }
      }
      if (cancelled || !mounted.current) return;
      // A token you RECEIVED leaves no trace in your history, so only a sweep
      // can find it. TTL-gated so revisiting the panel is not a re-sweep.
      if (await isDiscoveryDue(url, owner)) {
        if (cancelled || !mounted.current) return;
        await discover(ac);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [wallet, rpc, discover]);

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

  /** Sweep now, ignoring the TTL — for a token that arrived a moment ago. */
  const doRescan = useCallback(async () => {
    const outcome = await discover(new AbortController(), { force: true });
    if (!mounted.current) return;
    if (outcome.kind === 'done') {
      pushToast(
        'success',
        t('tokens.scanDone').replace('{n}', String(outcome.result.holdings.length)),
      );
    } else if (outcome.kind === 'cancelled') {
      pushToast('info', t('tokens.scanCancelled'));
    } else if (outcome.kind === 'error') {
      pushToast('error', outcome.message);
    }
  }, [discover, pushToast, t]);

  const doRemove = useCallback(async () => {
    if (!wallet || !rpc || !confirmRemove) return;
    const target = confirmRemove;
    setConfirmRemove(null);
    await removeToken(rpc.url, wallet.addr, target.contract);
    setHoldings(await loadCachedHoldings(rpc.url, wallet.addr));
  }, [wallet, rpc, confirmRemove]);

  if (!wallet || !rpc) return <PanelSkeleton title={t('tokens.title')} rows={3} />;

  const scanning = phase === 'discovering';
  const pct =
    progress && progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;

  const addrInvalid = Boolean(addr) && !isValidAddress(addr.trim());

  return (
    <div className="page">
      <PageHead
        icon="gem"
        title={t('tokens.title')}
        sub={t('tokens.tooltip')}
        actions={
          <button
            className="icon-btn"
            onClick={doRefresh}
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
            disabled={busy || phase !== 'idle' || holdings.length === 0}
          >
            <Icon name="refresh" size={16} />
          </button>
        }
      />

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Icon name="gem" size={18} /> {t('tokens.title')}
            <InfoHint text={t('tokens.tooltip')} />
          </div>
        </div>

        {/* Manual add — instant, and the only route for a token whose contract
            the node does not list. */}
        <div className="form-row">
          <label htmlFor="tokenAddr">{t('tokens.addLabel')}</label>
          <div className="input-row">
            <input
              id="tokenAddr"
              className="mono"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="oct…"
              onKeyDown={(e) => e.key === 'Enter' && doAdd()}
              disabled={busy || scanning}
              aria-invalid={addrInvalid}
              data-invalid={addrInvalid ? 'true' : undefined}
            />
            <button className="primary" onClick={doAdd} disabled={busy || scanning || !addr.trim()}>
              {t('tokens.add')}
            </button>
          </div>
        </div>

        {/* Discovery runs by itself; this explains what it is doing and lets the
            user force it or stop it. */}
        <div className="info-box">
          <Icon name="search" size={16} />
          <div className="stack tight grow">
            <span>{t('tokens.autoExplainer')}</span>
            {scanning ? (
              <>
                <div className="row tight">
                  <span className="spinner" />
                  <span>{t('tokens.discovering')}</span>
                  <span className="mono">
                    {progress ? `${progress.scanned}/${progress.total}` : '…'}
                  </span>
                  <span>{t('tokens.scanFound').replace('{n}', String(progress?.found ?? 0))}</span>
                  <button className="ghost btn-sm" onClick={() => abortRef.current?.abort()}>
                    {t('common.cancel')}
                  </button>
                </div>
                <div className="progress">
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="progress-pct">{pct}%</div>
              </>
            ) : (
              <button
                className="ghost btn-sm self-start"
                onClick={doRescan}
                disabled={busy || phase !== 'idle'}
              >
                <Icon name="search" size={14} /> {t('tokens.scan')}
              </button>
            )}
          </div>
        </div>

        {/* A sweep that lost reads is reported rather than presented as
            complete — the missing token would otherwise look like it does not
            exist. */}
        {unreadable > 0 && !scanning && (
          <div className="info-box warn spaced-top">
            <Icon name="alert-triangle" size={16} />
            <span>{t('tokens.partial').replace('{n}', String(unreadable))}</span>
          </div>
        )}

        {error && (
          <div className="info-box err spaced-top" role="alert">
            <Icon name="alert-triangle" size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">{t('tokens.holdings')}</div>
          <span className="card-meta">
            {t('tokens.onNetwork').replace('{network}', networkName)}
            {holdings.length > 0 ? ` · ${holdings.length}` : ''}
            {phase === 'refreshing' && <span className="spinner" />}
          </span>
        </div>

        {!loaded ? (
          <div className="stack">
            <div className="skeleton row" />
            <div className="skeleton row" />
          </div>
        ) : holdings.length === 0 ? (
          <div className="empty-state">
            <div className="icon">
              <Icon name={scanning ? 'search' : 'gem'} size={28} />
            </div>
            {/* Mid-sweep an empty list means "not found yet", which is a very
                different message from "you hold nothing". */}
            <div className="title">
              {scanning ? t('tokens.searchingTitle') : t('tokens.emptyTitle')}
            </div>
            <div className="desc">
              {scanning
                ? t('tokens.searchingDesc').replace('{network}', networkName)
                : t('tokens.emptyDesc').replace('{network}', networkName)}
            </div>
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
                    {h.deployed && !h.custom && (
                      <span className="tag ok">{t('tokens.deployed')}</span>
                    )}
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
                  <div className="row tight">
                    <button
                      className="ghost btn-sm"
                      onClick={() => setSending(h)}
                      // Without decimals the amount cannot be scaled safely, so
                      // sending is blocked rather than risking a wrong amount.
                      disabled={h.raw === 0n || h.decimals === null}
                      title={h.decimals === null ? t('tokenTx.unknownDecimals') : undefined}
                    >
                      {t('tokenTx.send')}
                    </button>
                    <button className="ghost btn-sm" onClick={() => setConfirmRemove(h)}>
                      {t('tokens.remove')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="field-note">
          <Icon name="alert-triangle" size={14} />
          <span>{t('tokens.spoofWarning')}</span>
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
        icon="trash"
        danger
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
    </div>
  );
}
