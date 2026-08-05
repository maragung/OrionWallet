import { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { getBalance } from '../api/send';
import {
  encryptBalance,
  decryptBalance,
  getEncryptedBalanceRaw,
  ENCRYPT_STEPS,
  DECRYPT_STEPS,
} from '../api/encrypt';
import { formatAmount, parseAmountRaw, recommendedOu } from '../tx/builder';
import { ConfirmDialog } from './ConfirmDialog';
import { ProcessingModal, useProcessingModal } from './ProcessingModal';
import { Tooltip } from './Tooltip';
import { PanelSkeleton } from './PanelSkeleton';

type Mode = 'encrypt' | 'decrypt';

export function EncryptPanel() {
  const { wallet, rpc, pushToast, pvacStatus, pvacBridgeReady } = useWalletStore();
  const [mode, setMode] = useState<Mode>('encrypt');
  const [amount, setAmount] = useState('');
  const [publicRaw, setPublicRaw] = useState<string | null>(null);
  const [encryptedRaw, setEncryptedRaw] = useState<string | null>(null);
  const [loadingBal, setLoadingBal] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const modal = useProcessingModal();

  const refresh = useCallback(async () => {
    if (!wallet || !rpc) return;
    setLoadingBal(true);
    try {
      const [b, encRaw] = await Promise.all([
        getBalance(rpc, wallet.addr),
        getEncryptedBalanceRaw(wallet, rpc).catch(() => '0'),
      ]);
      setPublicRaw(b.balance_raw ?? parseAmountRaw(b.balance || '0'));
      setEncryptedRaw(encRaw);
    } catch (e) {
      pushToast('error', `Failed to load balances: ${(e as Error).message}`);
    } finally {
      setLoadingBal(false);
    }
  }, [wallet, rpc, pushToast]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, rpc]);

  if (!wallet) return <PanelSkeleton title="Private Balance" rows={3} />;

  const pvacReady = pvacStatus === 'ready' && pvacBridgeReady;

  const fee = recommendedOu(mode, 0n);
  const amountRaw = (() => {
    try {
      return amount ? parseAmountRaw(amount) : null;
    } catch {
      return null;
    }
  })();
  const validAmount = amountRaw !== null && BigInt(amountRaw) > 0n;

  const sourceRaw = mode === 'encrypt' ? publicRaw : encryptedRaw;
  const sourceLabel = mode === 'encrypt' ? 'Public' : 'Encrypted';
  const targetLabel = mode === 'encrypt' ? 'Encrypted' : 'Public';

  const requestSubmit = () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!pvacReady) return pushToast('error', 'PVAC module not ready');
    if (!validAmount) return pushToast('error', 'Invalid amount');
    setShowConfirm(true);
  };

  const handleSubmit = async () => {
    setShowConfirm(false);
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!validAmount) return pushToast('error', 'Invalid amount');

    setResult(null);
    const isEncrypt = mode === 'encrypt';
    const submittedRaw = amountRaw!;

    modal.start(
      isEncrypt ? 'Encrypting Balance' : 'Decrypting Balance',
      isEncrypt ? ENCRYPT_STEPS : DECRYPT_STEPS,
      isEncrypt
        ? 'Building the homomorphic ciphertext and zero-knowledge proof…'
        : 'Building the ciphertext, range proof and zero-knowledge proof…',
    );

    try {
      const fn = isEncrypt ? encryptBalance : decryptBalance;
      const res = await fn(wallet, rpc, amount, modal.reporter);

      setResult(res.tx.hash);
      setPublicRaw(res.newPublicRaw);
      setEncryptedRaw(res.newEncryptedRaw);
      setAmount('');
      modal.setSuccess(
        [
          `${isEncrypt ? 'Encrypted' : 'Decrypted'} ${formatAmount(submittedRaw)} OCT.`,
          '',
          `Hash:      ${res.tx.hash}`,
          `Nonce:     ${res.submitResult.nonce}`,
          `Public:    ${formatAmount(res.newPublicRaw)} OCT`,
          `Encrypted: ${formatAmount(res.newEncryptedRaw)} OCT`,
        ].join('\n'),
      );
      pushToast(
        'success',
        `${isEncrypt ? 'Encrypted' : 'Decrypted'} ${formatAmount(submittedRaw)} OCT`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      modal.setError(msg);
      pushToast('error', `${isEncrypt ? 'Encrypt' : 'Decrypt'} failed: ${msg}`);
    }
  };

  const maxAmount = () => {
    if (!sourceRaw) return;
    let max = BigInt(sourceRaw);
    if (mode === 'encrypt') max -= BigInt(fee); // encrypt spends fee from public too
    if (max < 0n) max = 0n;
    setAmount(formatAmount(max.toString()));
  };

  return (
    <>
      {/* Balance summary */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            🔐 Private Balance{' '}
            <Tooltip text="Move OCT between your public and encrypted balances. The encrypted balance is stored on-chain as an AES-256-GCM ciphertext that only your wallet key can read.">
              <span
                style={{ color: 'var(--text-muted)', cursor: 'help', fontSize: 'var(--fs-sm)' }}
              >
                ⓘ
              </span>
            </Tooltip>
          </div>
          <button
            className="ghost icon"
            onClick={refresh}
            disabled={loadingBal}
            title="Refresh balances"
            aria-label="Refresh"
          >
            {loadingBal ? <span className="spinner" /> : '↻'}
          </button>
        </div>

        <div className="grid-2">
          <div>
            <div className="balance-label">Public Balance</div>
            <div
              style={{
                fontSize: 'var(--fs-lg)',
                fontFamily: 'var(--font-mono)',
                fontWeight: 'var(--fw-semibold)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {publicRaw !== null ? formatAmount(publicRaw) : '—'}{' '}
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>OCT</span>
            </div>
          </div>
          <div>
            <div className="balance-label">
              Encrypted Balance{' '}
              <span className="tag info" style={{ fontSize: 'var(--fs-xs)' }}>
                🔒
              </span>
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
              {encryptedRaw !== null ? formatAmount(encryptedRaw) : '—'}{' '}
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>OCT</span>
            </div>
          </div>
        </div>
      </div>

      {/* Operation card */}
      <div className="card">
        <div className="tab-bar">
          <div
            className={`tab ${mode === 'encrypt' ? 'active' : ''}`}
            onClick={() => {
              setMode('encrypt');
              setAmount('');
              setResult(null);
            }}
          >
            🔒 Encrypt
          </div>
          <div
            className={`tab ${mode === 'decrypt' ? 'active' : ''}`}
            onClick={() => {
              setMode('decrypt');
              setAmount('');
              setResult(null);
            }}
          >
            🔓 Decrypt
          </div>
        </div>

        <p
          style={{
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-muted)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          {mode === 'encrypt'
            ? 'Move OCT from your public balance into your encrypted (private) balance.'
            : 'Move OCT from your encrypted balance back into your public balance.'}
        </p>

        {!pvacReady && (
          <div
            style={{
              marginBottom: 'var(--sp-4)',
              padding: 'var(--sp-3)',
              background: 'var(--warning-soft)',
              border: '1px solid var(--warning)',
              borderRadius: 'var(--r-md)',
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-secondary)',
            }}
          >
            ⚠️ PVAC module is not ready ({pvacStatus}). Encrypted balance operations use FHE
            ciphertexts and zero-knowledge proofs, so they require the PVAC WASM module. Try
            reloading it from Settings.
          </div>
        )}

        <div className="form-row">
          <label htmlFor="enc-amount">Amount (OCT)</label>
          <div style={{ position: 'relative' }}>
            <input
              id="enc-amount"
              className="mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1.5"
              inputMode="decimal"
              autoComplete="off"
              style={amount && !validAmount ? { borderColor: 'var(--error)' } : undefined}
            />
            <button
              type="button"
              className="ghost"
              onClick={maxAmount}
              disabled={!sourceRaw}
              style={{
                position: 'absolute',
                right: 4,
                top: '50%',
                transform: 'translateY(-50%)',
                minHeight: 32,
                fontSize: 'var(--fs-xs)',
                padding: '0 var(--sp-2)',
              }}
            >
              MAX
            </button>
          </div>
          {amountRaw && (
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: 'var(--fs-xs)',
                marginTop: 'var(--sp-1)',
              }}
            >
              {sourceLabel} → {targetLabel} · fee {formatAmount(fee)} OCT
            </div>
          )}
        </div>

        <div className="form-actions">
          <button className="primary" onClick={requestSubmit} disabled={!validAmount || !pvacReady}>
            {mode === 'encrypt' ? '🔒 Encrypt' : '🔓 Decrypt'}
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
              {result}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        icon={mode === 'encrypt' ? '🔒' : '🔓'}
        title={mode === 'encrypt' ? 'Confirm Encrypt' : 'Confirm Decrypt'}
        message={
          mode === 'encrypt'
            ? 'This moves OCT from your public balance into your encrypted balance. This action cannot be undone.'
            : 'This moves OCT from your encrypted balance back into your public balance. This action cannot be undone.'
        }
        confirmLabel={mode === 'encrypt' ? 'Encrypt' : 'Decrypt'}
        cancelLabel="Cancel"
        onConfirm={handleSubmit}
        onCancel={() => setShowConfirm(false)}
        details={[
          `Operation: ${mode === 'encrypt' ? 'Public → Encrypted' : 'Encrypted → Public'}`,
          `Amount:    ${amountRaw ? formatAmount(amountRaw) : amount} OCT`,
          `Fee:       ${formatAmount(fee)} OCT`,
        ].join('\n')}
      />

      <ProcessingModal
        open={modal.open}
        title={modal.title}
        stages={modal.stages}
        message={modal.message}
        error={modal.error}
        success={modal.success}
        successMessage={modal.successMessage}
        successAction={{ label: 'Done', onClick: modal.close }}
        errorAction={{ label: 'Close', onClick: modal.close }}
        onClose={modal.close}
        dismissible={!!modal.success || !!modal.error}
      />
    </>
  );
}
