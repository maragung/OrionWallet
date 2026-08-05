import { useMemo, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useI18n } from '../i18n/useI18n';
import { isValidAddress } from '../crypto/address';
import { parseAmountToRaw, formatTokenAmount, type AmountError } from '../tokens/ocs01';
import { transferToken, type TokenHolding } from '../api/tokens';

interface Props {
  token: TokenHolding;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Transfer form for a single OCS01 token.
 *
 * Two-step: compose, then confirm. The confirmation shows the exact raw base
 * units alongside the human amount, because that integer is what the signature
 * commits to — and it cannot be corrected after signing.
 */
export function TokenTransferForm({ token, onClose, onDone }: Props) {
  const { wallet, rpc, pushToast } = useWalletStore();
  const { t } = useI18n();

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(
    () => (amount.trim() === '' ? null : parseAmountToRaw(amount, token.decimals)),
    [amount, token.decimals],
  );

  const amountError: AmountError | null = parsed && !parsed.ok ? parsed.error : null;
  const raw = parsed?.ok ? parsed.raw : null;
  const exceedsBalance = raw !== null && raw > token.raw;

  const toValid = isValidAddress(to.trim());
  const isSelf = to.trim() === wallet?.addr;

  const canSubmit = toValid && !isSelf && raw !== null && raw > 0n && !exceedsBalance && !busy;

  const amountMessage = (): string | null => {
    if (isSelf) return t('tokenTx.selfTransfer');
    switch (amountError) {
      case 'too-precise':
        return t('tokenTx.tooPrecise').replace('{n}', String(token.decimals ?? 0));
      case 'unknown-decimals':
        return t('tokenTx.unknownDecimals');
      case 'exceeds-u128':
        return t('tokenTx.tooLarge');
      case 'negative':
      case 'malformed':
        return t('tokenTx.badAmount');
      default:
        break;
    }
    if (exceedsBalance) return t('tokenTx.insufficient');
    return null;
  };

  const submit = async () => {
    if (!wallet || !rpc || raw === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await transferToken(rpc, wallet, {
        contract: token.contract,
        to: to.trim(),
        raw,
      });
      pushToast('success', `${t('tokenTx.sent')} ${res.hash.slice(0, 16)}…`);
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      pushToast('error', msg);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const symbol = token.symbol ?? t('tokens.unknownSymbol');

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => !busy && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3000,
        padding: 'var(--sp-4)',
        animation: 'fadeIn var(--t-base)',
      }}
    >
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated-1)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--sp-6)',
          maxWidth: 460,
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          animation: 'slideUp var(--t-base)',
        }}
      >
        <div className="card-header">
          <div className="card-title">
            {t('tokenTx.title')} {symbol}
          </div>
          <button className="ghost icon" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        {token.decimals === null && (
          <div className="tag warn" style={{ marginBottom: 'var(--sp-3)' }}>
            {t('tokenTx.unknownDecimals')}
          </div>
        )}

        {!confirming ? (
          <>
            <div className="form-row">
              <label htmlFor="ttTo">{t('tokenTx.recipient')}</label>
              <input
                id="ttTo"
                className="mono"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="oct…"
                style={to && !toValid ? { borderColor: 'var(--error)' } : undefined}
              />
            </div>

            <div className="form-row">
              <label htmlFor="ttAmount">
                {t('tokenTx.amount')} ({symbol})
              </label>
              <input
                id="ttAmount"
                className="mono"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
                disabled={token.decimals === null}
                style={amountError || exceedsBalance ? { borderColor: 'var(--error)' } : undefined}
              />
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                {t('tokenTx.available')}{' '}
                <span className="mono" title={token.amount.exact}>
                  {token.amount.display}
                </span>
                {token.decimals !== null && (
                  <button
                    className="ghost"
                    style={{ marginLeft: 'var(--sp-2)' }}
                    onClick={() => setAmount(formatTokenAmount(token.raw, token.decimals).exact)}
                  >
                    {t('tokenTx.max')}
                  </button>
                )}
              </div>
            </div>

            {amountMessage() && (
              <div style={{ color: 'var(--error)', fontSize: 'var(--fs-sm)' }}>
                ⚠️ {amountMessage()}
              </div>
            )}

            <div className="form-actions">
              <button className="ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button className="primary" disabled={!canSubmit} onClick={() => setConfirming(true)}>
                {t('common.continue')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="token-confirm-rows">
              <div>
                <span>{t('tokenTx.token')}</span>
                <span className="mono">{symbol}</span>
              </div>
              <div>
                <span>{t('tokenTx.contract')}</span>
                <span className="mono">{token.contract}</span>
              </div>
              <div>
                <span>{t('tokenTx.recipient')}</span>
                <span className="mono">{to.trim()}</span>
              </div>
              <div>
                <span>{t('tokenTx.amount')}</span>
                <span className="mono">
                  {raw !== null && formatTokenAmount(raw, token.decimals).display} {symbol}
                </span>
              </div>
              <div>
                {/* The signature commits to this integer, so show it verbatim. */}
                <span>{t('tokenTx.rawUnits')}</span>
                <span className="mono">{raw?.toString()}</span>
              </div>
            </div>

            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              {t('tokenTx.irreversible')}
            </div>

            {error && (
              <div style={{ color: 'var(--error)', fontSize: 'var(--fs-sm)' }}>⚠️ {error}</div>
            )}

            <div className="form-actions">
              <button className="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                {t('common.back')}
              </button>
              <button className="primary" onClick={submit} disabled={busy}>
                {busy ? <span className="spinner" /> : t('tokenTx.confirm')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
