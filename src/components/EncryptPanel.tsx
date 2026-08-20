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
import { copyText } from '../utils/clipboard';
import { ConfirmDialog } from './ConfirmDialog';
import { ProcessingModal, useProcessingModal } from './ProcessingModal';
import { InfoHint } from './Tooltip';
import { PanelSkeleton } from './PanelSkeleton';
import { PageHead } from './PageHead';
import { Icon } from './icons/Icon';

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
    <div className="page">
      <PageHead
        icon="shield-lock"
        title="Private Balance"
        sub="Move OCT between your public balance and your encrypted balance."
        actions={
          <button
            className="icon-btn"
            onClick={refresh}
            disabled={loadingBal}
            title="Refresh balances"
            aria-label="Refresh"
          >
            <Icon
              name={loadingBal ? 'loader' : 'refresh'}
              size={18}
              className={loadingBal ? 'icon-spin' : undefined}
            />
          </button>
        }
      />

      {/* The two balances as tiles rather than a two-column grid inside a card: the
          same pair appears on Balance in this shape, and tiles reflow to one column
          on a phone without a breakpoint of their own. */}
      <div className="metric-grid">
        <div className="metric">
          <div className="metric-label">
            <Icon name="wallet" size={14} />
            Public Balance
            <InfoHint text="Spendable balance visible to everyone on the Octra network. Encrypting moves OCT out of it." />
          </div>
          <div className="metric-value">
            {publicRaw !== null ? formatAmount(publicRaw) : '—'}{' '}
            <span className="metric-unit">OCT</span>
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">
            <Icon name="shield-lock" size={14} />
            Encrypted Balance
            <InfoHint text="Stored on-chain as an AES-256-GCM ciphertext that only your wallet key can read. Decrypting moves OCT back into your public balance." />
          </div>
          <div className="metric-value">
            {encryptedRaw !== null ? formatAmount(encryptedRaw) : '—'}{' '}
            <span className="metric-unit">OCT</span>
          </div>
        </div>
      </div>

      {/* Operation card */}
      <div className="card">
        {/* Real buttons, not clickable divs: these switch which balance the form
            spends from, and a keyboard user could not reach them before. */}
        <div className="tab-bar" role="tablist" aria-label="Operation">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'encrypt'}
            className={`tab ${mode === 'encrypt' ? 'active' : ''}`}
            onClick={() => {
              setMode('encrypt');
              setAmount('');
              setResult(null);
            }}
          >
            <Icon name="lock" size={16} /> Encrypt
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'decrypt'}
            className={`tab ${mode === 'decrypt' ? 'active' : ''}`}
            onClick={() => {
              setMode('decrypt');
              setAmount('');
              setResult(null);
            }}
          >
            <Icon name="unlock" size={16} /> Decrypt
          </button>
        </div>

        <p className="card-desc">
          {mode === 'encrypt'
            ? 'Move OCT from your public balance into your encrypted (private) balance.'
            : 'Move OCT from your encrypted balance back into your public balance.'}
        </p>

        {!pvacReady && (
          <div className="info-box warn spaced">
            <Icon name="alert-triangle" size={18} />
            <div className="info-box-body">
              PVAC module is not ready ({pvacStatus}). Encrypted balance operations use FHE
              ciphertexts and zero-knowledge proofs, so they require the PVAC WASM module. Try
              reloading it from Settings.
            </div>
          </div>
        )}

        <div className="form-row">
          <label htmlFor="enc-amount">Amount (OCT)</label>
          {/* `affix-text` and not the icon-button default: `MAX` is a word, so the
              input's text has to stop further from the edge than a 36px glyph needs. */}
          <div className="input-wrap affix-text">
            <input
              id="enc-amount"
              className="mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1.5"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={amount !== '' && !validAmount}
              data-invalid={amount && !validAmount ? 'true' : undefined}
            />
            <button
              type="button"
              className="ghost btn-sm input-affix"
              onClick={maxAmount}
              disabled={!sourceRaw}
              title={`Use the whole ${sourceLabel.toLowerCase()} balance`}
            >
              MAX
            </button>
          </div>
          {amountRaw && (
            <div className="field-note">
              {sourceLabel} → {targetLabel} · fee {formatAmount(fee)} OCT
            </div>
          )}
        </div>

        <div className="form-actions">
          <button className="primary" onClick={requestSubmit} disabled={!validAmount || !pvacReady}>
            <Icon name={mode === 'encrypt' ? 'lock' : 'unlock'} size={18} />{' '}
            {mode === 'encrypt' ? 'Encrypt' : 'Decrypt'}
          </button>
        </div>

        {result && (
          <div className="info-box ok spaced-top">
            <Icon name="check-circle" size={18} />
            <div className="info-box-body">
              <strong className="ok-text">Transaction Submitted</strong>
              <div className="mono mono-line">{result}</div>
              <button
                className="ghost btn-sm self-start"
                onClick={() => {
                  copyText(result);
                  pushToast('success', 'Hash copied');
                }}
              >
                <Icon name="copy" size={14} /> Copy Hash
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        icon={mode === 'encrypt' ? 'lock' : 'unlock'}
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
    </div>
  );
}
