import { copyText } from '../utils/clipboard';
import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { getBalance, getFeeSchedule } from '../api/send';
import { formatAmount } from '../tx/builder';
import type { BalanceInfo, FeeSchedule } from '../rpc/client';
import { InfoHint } from './Tooltip';
import { Icon } from './icons/Icon';
import { PageHead } from './PageHead';

export function BalanceView({
  onManageEncrypted,
  onSend,
  onReceive,
  onHistory,
}: {
  onManageEncrypted?: () => void;
  onSend?: () => void;
  onReceive?: () => void;
  onHistory?: () => void;
} = {}) {
  const { wallet, rpc, pushToast } = useWalletStore();
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [fees, setFees] = useState<FeeSchedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = async () => {
    if (!wallet || !rpc) return;
    setLoading(true);
    setError(null);
    try {
      const [b, f] = await Promise.all([
        getBalance(rpc, wallet.addr),
        getFeeSchedule(rpc).catch((e) => {
          console.warn('Fee fetch failed:', e);
          return null;
        }),
      ]);
      setBalance(b);
      if (f) setFees(f);
      setLastUpdated(new Date());
    } catch (e) {
      const msg = (e as Error).message;
      // "sender not found" is not a real error — it means the account has no on-chain state yet
      if (msg.includes('sender not found') || msg.includes('not found')) {
        setBalance({
          addr: wallet.addr,
          balance: '0',
          balance_raw: '0',
          nonce: 0,
          encrypted_balance: '0',
          has_public_key: false,
        });
        setLastUpdated(new Date());
        setError(null);
      } else {
        setError(msg);
        pushToast('error', `Failed to fetch balance: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, rpc]);

  // Never render blank: while the wallet is still resolving (e.g. right after
  // unlock, before RPC/settings finish loading), show the same hero with a
  // skeleton in it, so the page keeps its shape instead of changing layout once
  // the account arrives.
  if (!wallet) {
    return (
      <div className="page">
        <PageHead
          icon="wallet"
          title="Balance"
          sub="Public and encrypted holdings for the active account. Refreshes every 30 seconds."
        />
        <section className="hero-balance">
          <div className="hero-top">
            <span className="hero-label">Public Balance</span>
          </div>
          <div className="skeleton on-hero hero-amount-ph" />
          <div className="hero-meta">Preparing wallet…</div>
        </section>
      </div>
    );
  }

  const amount = balance ? balance.balance || balance.balance_raw || '—' : '—';
  const isEncrypted = Boolean(
    balance && balance.encrypted_balance && balance.encrypted_balance !== '0',
  );
  const pending =
    balance?.pending_nonce !== undefined && balance.pending_nonce !== balance.nonce
      ? balance.pending_nonce - balance.nonce
      : 0;

  return (
    <div className="page">
      <PageHead
        icon="wallet"
        title="Balance"
        sub="Public and encrypted holdings for the active account. Refreshes every 30 seconds."
      />

      {/* The one coloured surface in the app. Everything else is a neutral card, so
          the balance is the focal point without any other view competing for it. */}
      <section className="hero-balance">
        <div className="hero-top">
          <span className="hero-label">
            Public Balance
            <InfoHint text="Your wallet's public balance on the Octra network. Updates automatically every 30 seconds. Click refresh to update immediately." />
          </span>
          <button
            className="icon-btn"
            onClick={refresh}
            disabled={loading}
            title="Refresh balance"
            aria-label="Refresh"
          >
            <Icon
              name={loading ? 'loader' : 'refresh'}
              size={18}
              className={loading ? 'icon-spin' : undefined}
            />
          </button>
        </div>

        {loading && !balance ? (
          <div className="skeleton on-hero hero-amount-ph" />
        ) : (
          <div className="hero-amount">
            {error ? '—' : amount}
            <span className="hero-unit">OCT</span>
          </div>
        )}

        <div className="hero-meta">
          {loading && !balance ? (
            'Fetching balance from network…'
          ) : error ? (
            <>
              <Icon name="alert-triangle" size={16} /> Network unreachable
            </>
          ) : lastUpdated ? (
            <>
              <Icon name="check-circle" size={16} /> Updated {lastUpdated.toLocaleTimeString()}
            </>
          ) : null}
        </div>
      </section>

      {error && (
        <div className="info-box err">
          <Icon name="alert-triangle" size={18} />
          <div className="info-box-body">
            <div>{error}</div>
            <button className="ghost btn-sm self-start" onClick={refresh}>
              <Icon name="refresh" size={14} /> Retry
            </button>
          </div>
        </div>
      )}

      {/* Facts that used to be a two-column grid inside the balance card. As tiles
          they reflow from three across to one without a breakpoint of their own. */}
      <div className="metric-grid">
        <div className="metric">
          <div className="metric-label">
            <Icon name="shield-lock" size={14} />
            Encrypted Balance
            <InfoHint text="Balance hidden using FHE (Fully Homomorphic Encryption). Only visible to the wallet owner. Requires PVAC WASM module." />
          </div>
          <div className="metric-value">
            {isEncrypted ? <span className="tag info">encrypted</span> : '0 OCT'}
          </div>
          {onManageEncrypted && (
            <button className="ghost btn-sm self-start" onClick={onManageEncrypted}>
              <Icon name="shield-lock" size={14} /> Encrypt / Decrypt
            </button>
          )}
        </div>

        <div className="metric">
          <div className="metric-label">
            <Icon name="history" size={14} />
            Nonce
            <InfoHint text="Transaction counter for this address. Each new transaction increments the nonce by 1. Used to prevent replay attacks." />
          </div>
          <div className="metric-value">{balance?.nonce ?? 0}</div>
          {pending > 0 && (
            <div className="metric-note warn">
              +{pending} pending {pending === 1 ? 'transaction' : 'transactions'}
            </div>
          )}
        </div>

        {fees && (
          <div className="metric">
            <div className="metric-label">
              <Icon name="send" size={14} />
              Recommended fee
            </div>
            <div className="metric-value">
              {fees.recommended.includes('.') ? fees.recommended : formatAmount(fees.recommended)}{' '}
              OCT
            </div>
            <div className="metric-note">Per standard transfer</div>
          </div>
        )}
      </div>

      {/* Quick actions — the usual next steps after checking a balance. */}
      {(onSend || onReceive || onHistory) && (
        <div className="quick-actions">
          {onSend && (
            <button className="quick-action" onClick={onSend}>
              <span className="qa-icon">
                <Icon name="send" size={22} />
              </span>
              <span>Send</span>
            </button>
          )}
          {onReceive && (
            <button className="quick-action" onClick={onReceive}>
              <span className="qa-icon">
                <Icon name="receive" size={22} />
              </span>
              <span>Receive</span>
            </button>
          )}
          {onManageEncrypted && (
            <button className="quick-action" onClick={onManageEncrypted}>
              <span className="qa-icon">
                <Icon name="shield-lock" size={22} />
              </span>
              <span>Private</span>
            </button>
          )}
          {onHistory && (
            <button className="quick-action" onClick={onHistory}>
              <span className="qa-icon">
                <Icon name="history" size={22} />
              </span>
              <span>History</span>
            </button>
          )}
        </div>
      )}

      {/* Address card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Icon name="qr-code" size={18} />
            Wallet Address
          </div>
          <button
            className="icon-btn plain"
            onClick={() => {
              copyText(wallet.addr);
              pushToast('success', 'Address copied');
            }}
            title="Copy address"
            aria-label="Copy address"
          >
            <Icon name="copy" size={18} />
          </button>
        </div>
        <div className="address-display">{wallet.addr}</div>
        <div className="stack tight pubkey-block">
          <span className="tag self-start">Public Key (base64)</span>
          <div className="address-display sm">{wallet.pubB64}</div>
        </div>
      </div>

      {/* Fee schedule */}
      {fees && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              <Icon name="filter" size={18} />
              Fee Schedule
              <InfoHint text="Current network transaction fees. 'Recommended' is the standard fee for normal transactions. Use 'Fast' for priority processing." />
            </div>
          </div>
          <div className="grid-2">
            <FeeRow label="Minimum" value={fees.minimum} />
            <FeeRow label="Base fee" value={fees.base_fee} />
            <FeeRow label="Recommended" value={fees.recommended} />
            <FeeRow label="Fast" value={fees.fast} />
          </div>
          {fees.usage_pct !== undefined && (
            <div className="panel-note">
              <div className="between">
                <span>Network usage</span>
                <span className={`usage-pct ${usageClass(fees.usage_pct)}`}>{fees.usage_pct}%</span>
              </div>
              <div className="progress">
                {/* Width and colour are the datum, so they stay inline. */}
                <div
                  className={`progress-fill ${usageClass(fees.usage_pct)}`}
                  style={{ width: `${Math.min(100, fees.usage_pct)}%` }}
                />
              </div>
              <div className="row tight">
                <span>Staging: {fees.staging_size ?? 0} pending tx</span>
                {fees.stealth_class !== undefined && (
                  <span className="row tight">
                    <Icon name={fees.stealth_class ? 'check' : 'x'} size={14} />
                    Stealth: {fees.stealth_class ? 'enabled' : 'disabled'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Congestion buckets, shared by the percentage label and the bar. */
function usageClass(pct: number): string {
  if (pct > 80) return 'err';
  if (pct > 50) return 'warn';
  return 'ok';
}

function FeeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <span className="mono">{value.includes('.') ? value : formatAmount(value)} OCT</span>
    </div>
  );
}
