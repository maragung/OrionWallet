import { copyText } from '../utils/clipboard';
import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { getBalance, getFeeSchedule } from '../api/send';
import { formatAmount } from '../tx/builder';
import type { BalanceInfo, FeeSchedule } from '../rpc/client';
import { Tooltip } from './Tooltip';

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
  // unlock, before RPC/settings finish loading), show a skeleton card so the
  // layout keeps its shape instead of flashing an empty page.
  if (!wallet) {
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">Balance</div>
        </div>
        <div className="balance-label">Public Balance</div>
        <div style={{ marginTop: 'var(--sp-2)' }}>
          <div className="skeleton" style={{ height: 40, width: 200 }} />
          <div
            style={{
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-muted)',
              marginTop: 'var(--sp-1)',
            }}
          >
            Preparing wallet…
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Balance hero card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            Balance{' '}
            <Tooltip text="Your wallet's public balance on the Octra network. Updates automatically every 30 seconds. Click refresh to update immediately.">
              <span
                style={{ color: 'var(--text-muted)', cursor: 'help', fontSize: 'var(--fs-sm)' }}
              >
                ⓘ
              </span>
            </Tooltip>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            {lastUpdated && !loading && (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <button
              className="ghost icon"
              onClick={refresh}
              disabled={loading}
              title="Refresh balance"
              aria-label="Refresh"
            >
              {loading ? <span className="spinner" /> : '↻'}
            </button>
          </div>
        </div>

        {/* Public balance — hero */}
        <div style={{ marginBottom: 'var(--sp-5)' }}>
          <div className="balance-label">Public Balance</div>
          {loading && !balance ? (
            <div style={{ marginTop: 'var(--sp-2)' }}>
              <div className="skeleton" style={{ height: 40, width: 200 }} />
              <div
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--text-muted)',
                  marginTop: 'var(--sp-1)',
                }}
              >
                Fetching balance from network...
              </div>
            </div>
          ) : error ? (
            <div
              style={{
                color: 'var(--error)',
                fontSize: 'var(--fs-sm)',
                marginTop: 'var(--sp-2)',
                padding: 'var(--sp-3)',
                background: 'var(--error-soft)',
                borderRadius: 'var(--r-md)',
              }}
            >
              ⚠️ {error}
              <br />
              <button
                className="ghost"
                style={{ marginTop: 'var(--sp-2)', minHeight: 32 }}
                onClick={refresh}
              >
                ↻ Retry
              </button>
            </div>
          ) : (
            <div className="balance-display">
              {balance ? balance.balance || balance.balance_raw || '—' : '—'}{' '}
              <span
                style={{
                  fontSize: 'var(--fs-md)',
                  color: 'var(--text-muted)',
                  fontWeight: 'var(--fw-normal)',
                }}
              >
                OCT
              </span>
            </div>
          )}
        </div>

        {/* Encrypted + Nonce — grid */}
        <div className="grid-2">
          <div>
            <div className="balance-label">
              Encrypted Balance{' '}
              <Tooltip text="Balance hidden using FHE (Fully Homomorphic Encryption). Only visible to the wallet owner. Requires PVAC WASM module.">
                <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
              </Tooltip>
            </div>
            <div
              style={{
                fontSize: 'var(--fs-lg)',
                fontFamily: 'var(--font-mono)',
                fontWeight: 'var(--fw-semibold)',
                color: 'var(--text-secondary)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {balance && balance.encrypted_balance && balance.encrypted_balance !== '0' ? (
                <span className="tag info">🔒 encrypted</span>
              ) : (
                '0 OCT'
              )}
            </div>
            {onManageEncrypted && (
              <button
                className="ghost"
                onClick={onManageEncrypted}
                style={{ marginTop: 'var(--sp-2)', minHeight: 32, fontSize: 'var(--fs-xs)' }}
              >
                🔐 Encrypt / Decrypt
              </button>
            )}
          </div>
          <div>
            <div className="balance-label">
              Nonce{' '}
              <Tooltip text="Transaction counter for this address. Each new transaction increments the nonce by 1. Used to prevent replay attacks.">
                <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
              </Tooltip>
            </div>
            <div
              style={{
                fontSize: 'var(--fs-lg)',
                fontFamily: 'var(--font-mono)',
                fontWeight: 'var(--fw-semibold)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {balance?.nonce ?? 0}
              {balance?.pending_nonce !== undefined && balance.pending_nonce !== balance.nonce && (
                <span
                  style={{
                    color: 'var(--warning)',
                    fontSize: 'var(--fs-sm)',
                    marginLeft: 'var(--sp-2)',
                  }}
                >
                  (+{balance.pending_nonce - balance.nonce} pending)
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick actions — the usual next steps after checking a balance. */}
      {(onSend || onReceive || onHistory) && (
        <div className="quick-actions">
          {onSend && (
            <button className="quick-action" onClick={onSend}>
              <span className="qa-icon">📤</span>
              <span>Send</span>
            </button>
          )}
          {onReceive && (
            <button className="quick-action" onClick={onReceive}>
              <span className="qa-icon">📥</span>
              <span>Receive</span>
            </button>
          )}
          {onManageEncrypted && (
            <button className="quick-action" onClick={onManageEncrypted}>
              <span className="qa-icon">🔐</span>
              <span>Private</span>
            </button>
          )}
          {onHistory && (
            <button className="quick-action" onClick={onHistory}>
              <span className="qa-icon">📜</span>
              <span>History</span>
            </button>
          )}
        </div>
      )}

      {/* Address card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Wallet Address</div>
          <button
            className="ghost icon"
            onClick={() => {
              copyText(wallet.addr);
              pushToast('success', 'Address copied');
            }}
            title="Copy address"
          >
            📋
          </button>
        </div>
        <div className="address-display">{wallet.addr}</div>
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <span className="tag">Public Key (base64)</span>
          <div
            className="address-display"
            style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-xs)' }}
          >
            {wallet.pubB64}
          </div>
        </div>
      </div>

      {/* Fee schedule */}
      {fees && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              Fee Schedule{' '}
              <Tooltip text="Current network transaction fees. 'Recommended' is the standard fee for normal transactions. Use 'Fast' for priority processing.">
                <span
                  style={{ color: 'var(--text-muted)', cursor: 'help', fontSize: 'var(--fs-sm)' }}
                >
                  ⓘ
                </span>
              </Tooltip>
            </div>
          </div>
          <div className="grid-2">
            <FeeRow label="Minimum" value={fees.minimum} />
            <FeeRow label="Base fee" value={fees.base_fee} />
            <FeeRow label="Recommended" value={fees.recommended} />
            <FeeRow label="Fast" value={fees.fast} />
          </div>
          {fees.usage_pct !== undefined && (
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
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 'var(--sp-1)',
                }}
              >
                <span>Network usage</span>
                <span
                  style={{
                    color:
                      fees.usage_pct > 80
                        ? 'var(--error)'
                        : fees.usage_pct > 50
                          ? 'var(--warning)'
                          : 'var(--success)',
                  }}
                >
                  {fees.usage_pct}%
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  background: 'var(--bg-elevated-3)',
                  borderRadius: 2,
                  overflow: 'hidden',
                  marginBottom: 'var(--sp-2)',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, fees.usage_pct)}%`,
                    background:
                      fees.usage_pct > 80
                        ? 'var(--error)'
                        : fees.usage_pct > 50
                          ? 'var(--warning)'
                          : 'var(--success)',
                    transition: 'width var(--t-base)',
                  }}
                />
              </div>
              <div>
                Staging: {fees.staging_size ?? 0} pending tx
                {fees.stealth_class !== undefined && (
                  <span style={{ marginLeft: 'var(--sp-3)' }}>
                    Stealth: {fees.stealth_class ? '✓ enabled' : '✗ disabled'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function FeeRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 'var(--sp-2) 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 'var(--fs-sm)' }}>
        {value.includes('.') ? value : formatAmount(value)} OCT
      </span>
    </div>
  );
}
