import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { QrCode } from './QrCode';
import { CopyButton } from './CopyButton';
import { PageHead } from './PageHead';
import { Icon } from './icons';
import { copyText } from '../utils/clipboard';
import { buildPaymentUri } from '../wallet/payment-uri';
import { PanelSkeleton } from './PanelSkeleton';

/**
 * Receive view — shows the wallet address as a QR code so another device can
 * scan it, plus copy/share shortcuts. Optionally encodes a requested amount.
 */
export function ReceiveView() {
  const { wallet, pushToast } = useWalletStore();
  const [amount, setAmount] = useState('');

  if (!wallet) return <PanelSkeleton title="Receive" rows={2} />;

  // Encode as a URI when an amount is requested so scanners can prefill it —
  // via the same builder the in-wallet scanner parses, so the two cannot drift.
  // With no amount the payload stays a bare address: it is what other wallets
  // and explorers accept when pasted, and every scanner understands it.
  const payload = amount.trim() ? buildPaymentUri(wallet.addr, amount.trim()) : wallet.addr;

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
    <div className="page">
      <PageHead
        icon="receive"
        title="Receive"
        sub="Let another device scan the code, or share the address. Adding an amount turns it into a payment request."
      />

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Icon name="receive" size={18} /> Receive OCT
          </div>
        </div>

        <div className="receive-stack">
          <div className="qr-frame">
            <QrCode value={payload} size={220} />
          </div>

          <div>
            <div className="receive-caption">Scan this code, or share your address</div>
            <div className="address-display center">{wallet.addr}</div>
          </div>

          <div className="row tight receive-actions">
            <CopyButton
              value={wallet.addr}
              label="Copy address"
              onCopied={() => pushToast('success', 'Address copied')}
            />
            {canShare && (
              <button className="ghost" onClick={share}>
                <Icon name="link" size={16} /> Share
              </button>
            )}
          </div>

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
              <div className="field-note">QR now encodes a request for {amount.trim()} OCT.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
