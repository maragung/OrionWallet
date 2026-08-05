import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { QrCode } from './QrCode';
import { CopyButton } from './CopyButton';
import { copyText } from '../utils/clipboard';
import { PanelSkeleton } from './PanelSkeleton';

/**
 * Receive view — shows the wallet address as a QR code so another device can
 * scan it, plus copy/share shortcuts. Optionally encodes a requested amount.
 */
export function ReceiveView() {
  const { wallet, pushToast } = useWalletStore();
  const [amount, setAmount] = useState('');

  if (!wallet) return <PanelSkeleton title="Receive" rows={2} />;

  // Encode as a URI when an amount is requested so scanners can prefill it.
  const payload = amount.trim() ? `octra:${wallet.addr}?amount=${amount.trim()}` : wallet.addr;

  const canShare = typeof navigator !== 'undefined' && !!navigator.share;

  const share = async () => {
    try {
      await navigator.share({
        title: 'My Octra address',
        text: payload,
      });
    } catch {
      // User dismissed the share sheet, or it is unavailable — fall back.
      await copyText(payload);
      pushToast('success', 'Address copied');
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">📥 Receive OCT</div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--sp-4)',
        }}
      >
        <div
          style={{
            padding: 'var(--sp-3)',
            background: '#ffffff',
            borderRadius: 'var(--r-lg)',
            boxShadow: 'var(--shadow-md)',
            lineHeight: 0,
          }}
        >
          <QrCode value={payload} size={220} />
        </div>

        <div style={{ width: '100%', textAlign: 'center' }}>
          <div
            style={{
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-muted)',
              marginBottom: 'var(--sp-2)',
            }}
          >
            Scan this code, or share your address
          </div>
          <div
            className="address-display"
            style={{ textAlign: 'center', fontSize: 'var(--fs-sm)' }}
          >
            {wallet.addr}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 'var(--sp-2)',
            width: '100%',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <CopyButton
            value={wallet.addr}
            label="Copy address"
            onCopied={() => pushToast('success', 'Address copied')}
            style={{ minHeight: 44 }}
          />
          {canShare && (
            <button className="ghost" onClick={share} style={{ minHeight: 44 }}>
              🔗 Share
            </button>
          )}
        </div>

        <div style={{ width: '100%' }}>
          <div className="form-row">
            <label htmlFor="recv-amount">Request a specific amount (optional)</label>
            <input
              id="recv-amount"
              className="mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              autoComplete="off"
            />
            {amount.trim() && (
              <div
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--text-muted)',
                  marginTop: 'var(--sp-1)',
                }}
              >
                QR now encodes a request for {amount.trim()} OCT.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
