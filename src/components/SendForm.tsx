import { copyText } from '../utils/clipboard';
import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { sendStandard } from '../api/send';
import { formatAmount, parseAmountRaw } from '../tx/builder';
import { isValidAddress } from '../crypto/address';
import { ProcessingModal, type ProcessingStage } from './ProcessingModal';
import { ConfirmDialog } from './ConfirmDialog';
import { Tooltip } from './Tooltip';
import { PanelSkeleton } from './PanelSkeleton';

export function SendForm() {
  const { wallet, rpc, pushToast } = useWalletStore();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<{ hash: string; nonce: number } | null>(null);

  // Processing modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStages, setModalStages] = useState<ProcessingStage[]>([]);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSuccess, setModalSuccess] = useState(false);
  const [modalSuccessMsg, setModalSuccessMsg] = useState('');

  if (!wallet) return <PanelSkeleton title="Send" rows={3} />;

  const amountRaw = (() => {
    try {
      return parseAmountRaw(amount);
    } catch {
      return null;
    }
  })();
  const validTo = isValidAddress(to);
  const validAmount = amountRaw !== null && BigInt(amountRaw) > 0n;
  const fee = '10000'; // 0.01 OCT standard fee

  const updateStage = (id: string, status: ProcessingStage['status'], desc?: string) => {
    setModalStages((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status, description: desc ?? s.description } : s)),
    );
  };

  const requestSend = () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!validTo) return pushToast('error', 'Invalid recipient address');
    if (!validAmount) return pushToast('error', 'Invalid amount');
    if (!pin) return pushToast('error', 'PIN required to authorize send');
    setShowConfirm(true);
  };

  const handleSend = async () => {
    setShowConfirm(false);
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!validTo) return pushToast('error', 'Invalid recipient address');
    if (!validAmount) return pushToast('error', 'Invalid amount');
    if (!pin) return pushToast('error', 'PIN required to authorize send');

    // Open processing modal with stages
    setModalError(null);
    setModalSuccess(false);
    setModalStages([
      {
        id: 'fetch',
        label: 'Fetching account nonce',
        description: 'Getting current nonce from network',
        status: 'pending',
      },
      {
        id: 'sign',
        label: 'Signing transaction',
        description: 'Generating Ed25519 signature',
        status: 'pending',
      },
      {
        id: 'submit',
        label: 'Submitting to network',
        description: 'Broadcasting transaction to Octra RPC',
        status: 'pending',
      },
      {
        id: 'confirm',
        label: 'Transaction submitted',
        description: 'Waiting for network acknowledgment',
        status: 'pending',
      },
    ]);
    setModalOpen(true);

    try {
      // Stage 1: Fetch nonce
      updateStage('fetch', 'active');
      await new Promise((r) => setTimeout(r, 300)); // brief delay for UX
      const bi = await rpc.getBalance(wallet.addr);
      if (!bi.ok || !bi.result) throw new Error(`Failed to fetch nonce: ${bi.error ?? 'unknown'}`);
      updateStage('fetch', 'done', `Nonce: ${bi.result.nonce + 1}`);

      // Stage 2: Sign
      updateStage('sign', 'active');
      await new Promise((r) => setTimeout(r, 200));

      // Stage 3: Submit
      updateStage('sign', 'done');
      updateStage('submit', 'active');
      const { tx, submitResult } = await sendStandard(wallet, rpc, { to, amount, pin, message });
      updateStage('submit', 'done', `Hash: ${tx.hash.slice(0, 16)}...`);

      // Stage 4: Confirm
      updateStage('confirm', 'active');
      await new Promise((r) => setTimeout(r, 500));
      updateStage('confirm', 'done', `Accepted at nonce ${submitResult.nonce}`);

      // Success
      setModalSuccess(true);
      setModalSuccessMsg(
        `Transaction submitted successfully!\n\nHash: ${tx.hash}\nNonce: ${submitResult.nonce}\nAmount: ${formatAmount(amountRaw)} OCT → ${to.slice(0, 12)}...`,
      );
      setResult({ hash: tx.hash, nonce: submitResult.nonce });
      pushToast('success', 'Transaction submitted successfully');

      // Reset form
      setTo('');
      setAmount('');
      setPin('');
      setMessage('');
    } catch (e) {
      const msg = (e as Error).message;
      setModalError(msg);
      pushToast('error', `Send failed: ${msg}`);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalError(null);
    setModalSuccess(false);
  };

  const copySuccessDetails = () => {
    if (modalSuccessMsg) {
      copyText(modalSuccessMsg);
      pushToast('success', 'Details copied');
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div className="card-title">📤 Send OCT</div>
          <Tooltip text="Send a standard transfer to another Octra address. The recipient will receive the funds immediately after the transaction is confirmed.">
            <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
          </Tooltip>
        </div>

        <div className="form-row">
          <label htmlFor="to">
            Recipient Address{' '}
            <Tooltip text="The Octra address of the recipient. Must start with 'oct' and be 47 characters long.">
              <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
            </Tooltip>
          </label>
          <input
            id="to"
            className="mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="oct..."
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            style={to && !validTo ? { borderColor: 'var(--error)' } : undefined}
          />
          {to && !validTo && (
            <div
              style={{ color: 'var(--error)', fontSize: 'var(--fs-xs)', marginTop: 'var(--sp-1)' }}
            >
              ⚠ Address must be 47 chars, start with "oct", and use valid base58.
            </div>
          )}
          {validTo && (
            <div
              style={{
                color: 'var(--success)',
                fontSize: 'var(--fs-xs)',
                marginTop: 'var(--sp-1)',
              }}
            >
              ✓ Valid Octra address
            </div>
          )}
        </div>

        <div className="form-row">
          <label htmlFor="amount">
            Amount (OCT){' '}
            <Tooltip text="Enter the amount in OCT (e.g., 1.5). The minimum unit is 0.000001 OCT (1 raw). Transaction fee is additional.">
              <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
            </Tooltip>
          </label>
          <input
            id="amount"
            className="mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1.5"
            inputMode="decimal"
            autoComplete="off"
            style={amount && !validAmount ? { borderColor: 'var(--error)' } : undefined}
          />
          {amountRaw && (
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: 'var(--fs-xs)',
                marginTop: 'var(--sp-1)',
              }}
            >
              Raw: {amountRaw} (≈ {formatAmount(amountRaw)} OCT) + fee {formatAmount(fee)} OCT
            </div>
          )}
          {/* Quick amount buttons */}
          <div style={{ display: 'flex', gap: 'var(--sp-1)', marginTop: 'var(--sp-2)' }}>
            {['0.1', '1', '10', '100'].map((v) => (
              <button
                key={v}
                type="button"
                className="ghost"
                onClick={() => setAmount(v)}
                style={{ flex: 1, minHeight: 32, fontSize: 'var(--fs-xs)', padding: 'var(--sp-1)' }}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="form-row">
          <label htmlFor="message">
            Message (optional){' '}
            <Tooltip text="Optional memo attached to the transaction. Visible to the recipient and on the explorer. Max 256 characters.">
              <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
            </Tooltip>
          </label>
          <input
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Memo"
            maxLength={256}
            autoComplete="off"
          />
          {message && (
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {message.length}/256 characters
            </div>
          )}
        </div>

        <div className="form-row">
          <label htmlFor="pin">
            PIN{' '}
            <Tooltip text="Your wallet PIN is required to authorize this transaction. It decrypts your private key temporarily to sign the transaction.">
              <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
            </Tooltip>
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="pin"
              type={showPin ? 'text' : 'password'}
              className="mono"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter your wallet PIN"
              autoComplete="current-password"
              style={{ paddingRight: 40 }}
            />
            <button
              type="button"
              className="ghost icon"
              onClick={() => setShowPin(!showPin)}
              title={showPin ? 'Hide PIN' : 'Show PIN'}
              style={{
                position: 'absolute',
                right: 4,
                top: '50%',
                transform: 'translateY(-50%)',
                minHeight: 36,
                minWidth: 36,
                border: 'none',
              }}
            >
              {showPin ? '🙈' : '👁️'}
            </button>
          </div>
        </div>

        <div className="form-actions">
          <button
            className="primary"
            onClick={requestSend}
            disabled={!validTo || !validAmount || !pin}
          >
            🔏 Sign & Send
          </button>
        </div>

        {result && (
          <div
            style={{
              marginTop: 'var(--sp-4)',
              padding: 'var(--sp-3)',
              background: 'var(--success-soft)',
              border: '1px solid var(--success)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--success)',
                marginBottom: 'var(--sp-1)',
                fontWeight: 'var(--fw-semibold)',
              }}
            >
              ✓ Transaction Submitted
            </div>
            <div className="mono" style={{ fontSize: 'var(--fs-xs)', wordBreak: 'break-all' }}>
              Hash: {result.hash}
            </div>
            <div
              className="mono"
              style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}
            >
              Nonce: {result.nonce}
            </div>
            <button
              className="ghost"
              style={{ marginTop: 'var(--sp-2)', minHeight: 32, fontSize: 'var(--fs-xs)' }}
              onClick={() => {
                copyText(result.hash);
                pushToast('success', 'Hash copied');
              }}
            >
              📋 Copy Hash
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        icon="📤"
        title="Confirm Transaction"
        message="Please review the transaction details before signing and broadcasting. This action cannot be undone."
        confirmLabel="Sign & Send"
        cancelLabel="Cancel"
        onConfirm={handleSend}
        onCancel={() => setShowConfirm(false)}
        details={[
          `To:      ${to}`,
          `Amount:  ${amountRaw ? formatAmount(amountRaw) : amount} OCT`,
          `Fee:     ${formatAmount(fee)} OCT`,
          `Total:   ${amountRaw ? formatAmount((BigInt(amountRaw) + BigInt(fee)).toString()) : '—'} OCT`,
          message ? `Message: ${message}` : null,
        ]
          .filter(Boolean)
          .join('\n')}
      />

      <ProcessingModal
        open={modalOpen}
        title="Sending Transaction"
        stages={modalStages}
        error={modalError}
        success={modalSuccess}
        successMessage={modalSuccessMsg}
        successAction={{ label: 'Done', onClick: closeModal }}
        successActionDisabled={true}
        errorAction={{ label: 'Close', onClick: closeModal }}
        onClose={closeModal}
        dismissible={!!modalSuccess || !!modalError}
        onCopySuccess={copySuccessDetails}
      />
    </>
  );
}
