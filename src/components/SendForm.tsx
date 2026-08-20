import { copyText } from '../utils/clipboard';
import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { sendStandard } from '../api/send';
import { fetchNextNonce } from '../api/nonce';
import { formatAmount, parseAmountRaw } from '../tx/builder';
import { isValidAddress } from '../crypto/address';
import { parsePaymentUri } from '../wallet/payment-uri';
import { listContacts, upsertContact, type ContactEntry } from '../wallet/storage';
import { ProcessingModal, type ProcessingStage } from './ProcessingModal';
import { ConfirmDialog } from './ConfirmDialog';
import { QrScanner } from './QrScanner';
import { InfoHint } from './Tooltip';
import { PanelSkeleton } from './PanelSkeleton';
import { PageHead } from './PageHead';
import { Icon } from './icons/Icon';

export function SendForm() {
  const { wallet, rpc, pushToast } = useWalletStore();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState<{ hash: string; nonce: number } | null>(null);
  const [nextNonce, setNextNonce] = useState<number | null>(null);
  const [nonceStatus, setNonceStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  // Address book: pick a saved recipient, or save the one just typed.
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [showScan, setShowScan] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);

  // Processing modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStages, setModalStages] = useState<ProcessingStage[]>([]);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSuccess, setModalSuccess] = useState(false);
  const [modalSuccessMsg, setModalSuccessMsg] = useState('');

  useEffect(() => {
    listContacts()
      .then(setContacts)
      .catch(() => setContacts([]));
  }, []);

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

  const knownContact = contacts.find((c) => c.addr === to) ?? null;

  // A scanned QR may be a bare address or an octra: payment URI carrying an
  // amount. Both are accepted; anything else is reported rather than pasted.
  const handleScan = (text: string) => {
    setShowScan(false);
    const parsed = parsePaymentUri(text);
    if (!parsed) {
      pushToast('error', 'That QR code does not contain a valid Octra address');
      return;
    }
    setTo(parsed.addr);
    if (parsed.amount) setAmount(parsed.amount);
    pushToast(
      'success',
      parsed.amount ? `Scanned address and amount (${parsed.amount} OCT)` : 'Scanned address',
    );
  };

  const saveRecipient = async () => {
    const name = saveName.trim();
    if (!name) return pushToast('error', 'Give the contact a name');
    try {
      await upsertContact(to, name);
      setContacts(await listContacts());
      setShowSave(false);
      setSaveName('');
      pushToast('success', `Saved ${name} to contacts`);
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Could not save contact');
    }
  };

  const requestSend = async () => {
    if (!rpc) return pushToast('error', 'RPC not initialized');
    if (!validTo) return pushToast('error', 'Invalid recipient address');
    if (!validAmount) return pushToast('error', 'Invalid amount');
    if (!pin) return pushToast('error', 'PIN required to authorize send');
    // Fetch the nonce up front so it can be shown in the confirmation dialog
    // before the signing flow starts. The fetched value is also what the signed
    // transaction uses (passed through to sendStandard).
    setNextNonce(null);
    setNonceStatus('loading');
    setShowConfirm(true);
    try {
      setNextNonce(await fetchNextNonce(rpc, wallet.addr));
      setNonceStatus('ready');
    } catch {
      setNonceStatus('error');
    }
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
      // Stage 1: Fetch nonce (display only — sendStandard re-fetches it unless
      // the confirm dialog already fetched it; the shown value is what signs).
      updateStage('fetch', 'active');
      await new Promise((r) => setTimeout(r, 300)); // brief delay for UX
      const nonce = nextNonce ?? (await fetchNextNonce(rpc, wallet.addr));
      updateStage('fetch', 'done', `Nonce: ${nonce}`);

      // Stage 2: Sign
      updateStage('sign', 'active');
      await new Promise((r) => setTimeout(r, 200));

      // Stage 3: Submit
      updateStage('sign', 'done');
      updateStage('submit', 'active');
      const { tx, submitResult } = await sendStandard(wallet, rpc, {
        to,
        amount,
        pin,
        message,
        nonce: nextNonce ?? undefined,
      });
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
      setNextNonce(null);
      setNonceStatus('loading');
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
    <div className="page">
      <PageHead
        icon="send"
        title="Send"
        sub="Transfer OCT to any Octra address. Amounts and fees are shown before you sign."
      />

      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Icon name="send" size={18} /> Send OCT
          </div>
          <InfoHint text="Send a standard transfer to another Octra address. The recipient will receive the funds immediately after the transaction is confirmed." />
        </div>

        {wallet.watchOnly && (
          <div className="info-box warn spaced">
            <Icon name="eye" size={18} />
            <span>
              This is a <strong>watch-only</strong> account. It holds no private key, so it cannot
              sign or send. Switch to an account with keys, or import the recovery phrase for this
              address.
            </span>
          </div>
        )}

        <div className="form-row">
          <div className="field-head">
            <label htmlFor="to">
              Recipient Address{' '}
              <InfoHint text="The Octra address of the recipient. Must start with 'oct' and be 47 characters long." />
            </label>
            <div className="field-head-actions">
              {contacts.length > 0 && (
                <select
                  className="field-inline"
                  aria-label="Pick a saved contact"
                  value={knownContact?.addr ?? ''}
                  onChange={(e) => {
                    if (e.target.value) setTo(e.target.value);
                  }}
                >
                  <option value="">Contacts…</option>
                  {contacts.map((c) => (
                    <option key={c.addr} value={c.addr}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="ghost btn-sm"
                onClick={() => setShowScan(true)}
                aria-label="Scan a QR code for the recipient"
              >
                <Icon name="camera" size={14} /> Scan
              </button>
            </div>
          </div>
          <input
            id="to"
            className="mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="oct..."
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={to !== '' && !validTo}
            /* The invalid border is a class, not an inline style, so that light
               theme and the focus ring can both still override it. */
            data-invalid={to && !validTo ? 'true' : undefined}
          />
          {to && !validTo && (
            <div className="field-error">
              <Icon name="alert-triangle" size={14} />
              <span>Address must be 47 chars, start with "oct", and use valid base58.</span>
            </div>
          )}
          {validTo && (
            <div className="field-note">
              <span className="ok-text">
                <Icon name="check-circle" size={14} /> Valid Octra address
              </span>
              {knownContact ? (
                <span className="row tight">
                  <Icon name="contact" size={14} className="muted" />
                  {knownContact.name}
                </span>
              ) : showSave ? (
                <>
                  <input
                    className="field-inline"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="Contact name"
                    aria-label="Contact name"
                    maxLength={64}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void saveRecipient();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="ghost btn-sm"
                    onClick={() => void saveRecipient()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="ghost btn-sm"
                    onClick={() => {
                      setShowSave(false);
                      setSaveName('');
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="ghost btn-sm" onClick={() => setShowSave(true)}>
                  <Icon name="plus" size={14} /> Save to contacts
                </button>
              )}
            </div>
          )}
        </div>

        <div className="form-row">
          <label htmlFor="amount">
            Amount (OCT){' '}
            <InfoHint text="Enter the amount in OCT (e.g., 1.5). The minimum unit is 0.000001 OCT (1 raw). Transaction fee is additional." />
          </label>
          <input
            id="amount"
            className="mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1.5"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={amount !== '' && !validAmount}
            data-invalid={amount && !validAmount ? 'true' : undefined}
          />
          {amountRaw && (
            <div className="field-note">
              Raw: {amountRaw} (≈ {formatAmount(amountRaw)} OCT) + fee {formatAmount(fee)} OCT
            </div>
          )}
          {/* Quick amount buttons */}
          <div className="preset-row">
            {['0.1', '1', '10', '100'].map((v) => (
              <button key={v} type="button" className="ghost btn-sm" onClick={() => setAmount(v)}>
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="form-row">
          <label htmlFor="message">
            Message (optional){' '}
            <InfoHint text="Optional memo attached to the transaction. Visible to the recipient and on the explorer. Max 256 characters." />
          </label>
          <input
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Memo"
            maxLength={256}
            autoComplete="off"
          />
          {message && <div className="field-note">{message.length}/256 characters</div>}
        </div>

        <div className="form-row">
          <label htmlFor="pin">
            PIN{' '}
            <InfoHint text="Your wallet PIN is required to authorize this transaction. It decrypts your private key temporarily to sign the transaction." />
          </label>
          <div className="input-wrap">
            <input
              id="pin"
              type={showPin ? 'text' : 'password'}
              className="mono"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter your wallet PIN"
              autoComplete="current-password"
            />
            <button
              type="button"
              className="icon-btn plain input-affix"
              onClick={() => setShowPin(!showPin)}
              title={showPin ? 'Hide PIN' : 'Show PIN'}
              aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
            >
              <Icon name={showPin ? 'eye-off' : 'eye'} size={18} />
            </button>
          </div>
        </div>

        <div className="form-actions">
          <button
            className="primary"
            onClick={requestSend}
            disabled={!validTo || !validAmount || !pin || wallet.watchOnly === true}
            title={wallet.watchOnly ? 'Watch-only accounts cannot sign transactions' : undefined}
          >
            <Icon name="signature" size={18} /> Sign &amp; Send
          </button>
        </div>

        {result && (
          <div className="info-box ok spaced">
            <Icon name="check-circle" size={18} />
            <div className="info-box-body">
              <strong className="ok-text">Transaction Submitted</strong>
              <div className="mono mono-line">Hash: {result.hash}</div>
              <div className="mono mono-line muted">Nonce: {result.nonce}</div>
              <button
                className="ghost btn-sm self-start"
                onClick={() => {
                  copyText(result.hash);
                  pushToast('success', 'Hash copied');
                }}
              >
                <Icon name="copy" size={14} /> Copy Hash
              </button>
            </div>
          </div>
        )}
      </div>

      <QrScanner
        open={showScan}
        title="Scan recipient"
        hint="Point the camera at an Octra address QR code. Decoding happens on-device; nothing is uploaded."
        onResult={handleScan}
        onClose={() => setShowScan(false)}
      />

      <ConfirmDialog
        open={showConfirm}
        icon="send"
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
          `Nonce:   ${
            nonceStatus === 'ready'
              ? String(nextNonce)
              : nonceStatus === 'error'
                ? 'unavailable'
                : 'fetching…'
          }`,
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
    </div>
  );
}
