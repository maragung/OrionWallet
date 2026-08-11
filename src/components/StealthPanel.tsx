import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { signTransaction, buildTxJson, parseAmountRaw, recommendedOu, nowTs } from '../tx/builder';
import { isValidAddress } from '../crypto/address';
import { prepareStealthSend, STEALTH_PREPARE_STEPS } from '../stealth';
import { base64Decode } from '../crypto/base64';
import { fetchNextNonce } from '../api/nonce';
import { formatAmount } from '../tx/builder';
import { ConfirmDialog } from './ConfirmDialog';
import { ProcessingModal, useProcessingModal } from './ProcessingModal';
import { shorten, formatBytes, type StepDescriptor } from '../utils/progress';
import { PanelSkeleton } from './PanelSkeleton';

/**
 * Full stealth-send sequence: the panel's own steps wrapped around the
 * key-derivation steps performed inside `prepareStealthSend`.
 */
const STEALTH_STEPS: StepDescriptor[] = [
  {
    id: 'validate',
    label: 'Validating request',
    description: 'Checking the recipient address and amount',
  },
  {
    id: 'fetch-pubkey',
    label: "Fetching recipient's public key",
    description: 'Required to derive the shared secret',
  },
  ...STEALTH_PREPARE_STEPS,
  {
    id: 'nonce',
    label: 'Fetching nonce & fee',
    description: 'Reading account state from the node',
  },
  {
    id: 'payload',
    label: 'Assembling stealth payload',
    description: 'Ephemeral pubkey, stealth tag, claim key and encrypted amount',
  },
  {
    id: 'sign',
    label: 'Signing transaction',
    description: 'Ed25519 signature over the canonical transaction',
  },
  {
    id: 'submit',
    label: 'Broadcasting to network',
    description: 'Submitting the transaction to the Octra RPC',
  },
];

export function StealthPanel() {
  const { wallet, rpc, pushToast, pvacBridgeReady } = useWalletStore();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const modal = useProcessingModal();

  if (!wallet) return <PanelSkeleton title="Stealth Send" rows={3} />;

  const stealthFee = recommendedOu('stealth', 0n);

  const requestSend = () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!isValidAddress(to)) return pushToast('error', 'Invalid recipient address');
    if (!amount) return pushToast('error', 'Amount required');
    if (!pin) return pushToast('error', 'PIN required');
    setShowConfirm(true);
  };

  const handleSend = async () => {
    setShowConfirm(false);
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!isValidAddress(to)) return pushToast('error', 'Invalid recipient address');
    if (!amount) return pushToast('error', 'Amount required');
    if (!pin) return pushToast('error', 'PIN required');

    setResult(null);
    modal.start(
      'Sending Stealth Transaction',
      STEALTH_STEPS,
      'Deriving one-time keys and encrypting the amount…',
    );
    const progress = modal.reporter;

    try {
      await progress.begin('validate');
      const amountRaw = parseAmountRaw(amount);
      if (BigInt(amountRaw) <= 0n) {
        progress.fail('validate', 'Amount must be greater than zero');
        throw new Error('Amount must be positive');
      }
      await progress.done(
        'validate',
        `${formatAmount(amountRaw)} OCT → ${to.slice(0, 10)}… (${amountRaw} raw)`,
      );

      // Step 1: Fetch recipient's Ed25519 public key
      await progress.begin('fetch-pubkey');
      const pkResp = await rpc.getPublicKey(to);
      if (!pkResp.ok || !pkResp.result?.public_key) {
        progress.fail('fetch-pubkey', pkResp.error ?? 'recipient has no published public key');
        throw new Error(`Cannot fetch recipient public key: ${pkResp.error ?? 'unknown'}`);
      }
      const recipientEdPub = base64Decode(pkResp.result.public_key);
      if (recipientEdPub.length !== 32) {
        progress.fail('fetch-pubkey', `Expected 32 bytes, got ${recipientEdPub.length}`);
        throw new Error('Recipient public key is not 32 bytes');
      }
      await progress.done(
        'fetch-pubkey',
        `Ed25519 key ${shorten(pkResp.result.public_key)} (32 bytes)`,
      );

      // Step 2: Prepare stealth send (ephemeral ECDH + amount encryption).
      // Reports the `STEALTH_PREPARE_STEPS` ids internally.
      const prepared = await prepareStealthSend(
        { recipientEd25519Pubkey: recipientEdPub, amountRaw },
        progress,
      );

      // Step 3: Fetch nonce (pending-aware)
      await progress.begin('nonce');
      const nonce = await fetchNextNonce(rpc, wallet.addr);
      const fee = recommendedOu('stealth', BigInt(amountRaw));
      await progress.done('nonce', `Nonce ${nonce} · stealth fee ${formatAmount(fee)} OCT`);

      // Step 4: Assemble the stealth payload
      await progress.begin('payload');
      const encryptedData = JSON.stringify({
        ephemeral_pubkey: prepared.ephemeralPubkeyB64,
        stealth_tag: prepared.stealthTagHex,
        claim_pub: prepared.claimPubB64,
        amount_payload: prepared.amountPayload,
      });
      await progress.done(
        'payload',
        `encrypted_data payload: ${formatBytes(encryptedData.length)}`,
      );

      // Step 5: Sign
      await progress.begin('sign');
      const tx = signTransaction({
        secretKey: wallet.sk,
        publicKeyB64: wallet.pubB64,
        fields: {
          from: wallet.addr,
          to, // recipient address (visible, but amount is hidden)
          amount: amountRaw,
          nonce,
          ou: fee,
          timestamp: nowTs(),
          op_type: 'stealth',
          encrypted_data: encryptedData,
        },
      });
      await progress.done('sign', `Signed · hash ${shorten(tx.hash, 12, 8)}`);

      // Step 6: Broadcast
      await progress.begin('submit');
      const submit = await rpc.submitTx(JSON.parse(buildTxJson(tx)));
      if (!submit.ok || !submit.result) {
        progress.fail('submit', submit.error ?? 'node rejected the transaction');
        throw new Error(`Submit failed: ${submit.error}`);
      }
      await progress.done('submit', `Accepted by node at nonce ${submit.result.nonce}`);

      setResult(tx.hash);
      modal.setSuccess(
        [
          `Stealth transaction submitted. Only ${to.slice(0, 10)}… can decrypt the amount.`,
          '',
          `Hash:        ${tx.hash}`,
          `Nonce:       ${submit.result.nonce}`,
          `Amount:      ${formatAmount(amountRaw)} OCT (encrypted on-chain)`,
          `Fee:         ${formatAmount(fee)} OCT`,
          `Stealth tag: ${prepared.stealthTagHex}`,
        ].join('\n'),
      );
      pushToast('success', `Stealth transaction submitted (hash=${tx.hash.slice(0, 12)}...)`);
      setTo('');
      setAmount('');
      setPin('');
    } catch (e) {
      const msg = (e as Error).message;
      modal.setError(msg);
      pushToast('error', `Stealth send failed: ${msg}`);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div className="card-title">Stealth Send</div>
        </div>

        <div
          style={{
            marginBottom: 16,
            padding: 12,
            background: 'var(--bg-tertiary)',
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          <strong>How it works:</strong> Stealth sends use ephemeral X25519 ECDH to derive a
          one-time stealth tag and claim key. The amount is encrypted with AES-256-GCM and only the
          recipient can decrypt it (by scanning the chain for matching stealth tags).
          <br />
          <br />
          {!pvacBridgeReady && (
            <span className="tag warn">
              ⚠️ PVAC bridge not ready — sender-side FHE balance subtraction is disabled. Stealth
              send still works for recipients with public balance.
            </span>
          )}
        </div>

        <div className="form-row">
          <label htmlFor="sto">Recipient Address</label>
          <input
            id="sto"
            className="mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="oct..."
          />
        </div>

        <div className="form-row">
          <label htmlFor="samt">Amount (OCT, will be encrypted)</label>
          <input
            id="samt"
            className="mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1.5"
            inputMode="decimal"
          />
        </div>

        <div className="form-row">
          <label htmlFor="spin">PIN</label>
          <input
            id="spin"
            type="password"
            className="mono"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </div>

        <div className="form-actions">
          <button className="primary" onClick={requestSend} disabled={!to || !amount || !pin}>
            Send Stealth
          </button>
        </div>

        <ConfirmDialog
          open={showConfirm}
          icon="🤫"
          title="Confirm Stealth Send"
          message="The amount will be encrypted so only the recipient can decrypt it. Note the stealth fee is higher than a standard transfer. This action cannot be undone."
          confirmLabel="Send Stealth"
          cancelLabel="Cancel"
          onConfirm={handleSend}
          onCancel={() => setShowConfirm(false)}
          details={[
            `To:      ${to}`,
            `Amount:  ${amount} OCT (encrypted)`,
            `Fee:     ${formatAmount(stealthFee)} OCT`,
          ].join('\n')}
        />

        {result && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: 'var(--bg-tertiary)',
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              Transaction Hash
            </div>
            <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {result}
            </div>
          </div>
        )}
      </div>

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
