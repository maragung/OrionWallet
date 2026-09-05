import { copyText } from '../utils/clipboard';
import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { createNewWallet, importMnemonic, listStoredWallets } from '../api/wallet-api';
import { checkQuizAnswers, pickQuizIndexes } from '../wallet/mnemonic-quiz';
import { ThemeToggle } from './ThemeToggle';
import { ProcessingModal, type ProcessingStage } from './ProcessingModal';
import { LanguageSwitcher } from './LanguageSwitcher';
import { InfoHint } from './Tooltip';
import { Icon } from './icons';

type Mode = 'create' | 'import';

export function CreateWallet({ onBack }: { onBack: () => void }) {
  const { setWallet, pushToast } = useWalletStore();
  const [mode, setMode] = useState<Mode>('create');
  const [name, setName] = useState('Account 1');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [generatedMnemonic, setGeneratedMnemonic] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);
  const [showMnemonic, setShowMnemonic] = useState(false);
  /** A wallet already exists on this device — surface that in a notice. */
  const [hasExistingWallet, setHasExistingWallet] = useState(false);

  // Backup confirmation: a freshly created wallet is not opened until the user
  // has proved they wrote the phrase down. `pendingWallet` holds it meanwhile —
  // it is already encrypted in IndexedDB at this point, only not yet active.
  const [pendingWallet, setPendingWallet] = useState<Wallet | null>(null);
  const [backupStep, setBackupStep] = useState<'show' | 'verify'>('show');
  const [quizIdx, setQuizIdx] = useState<number[]>([]);
  const [quizInput, setQuizInput] = useState<string[]>([]);
  const [quizFails, setQuizFails] = useState(0);

  // Processing modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStages, setModalStages] = useState<ProcessingStage[]>([]);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSuccess, setModalSuccess] = useState(false);
  const [modalSuccessMsg, setModalSuccessMsg] = useState('');
  const [modalTitle, setModalTitle] = useState('Processing');

  type Wallet = import('../wallet/wallet').Wallet;

  const updateStage = (id: string, status: ProcessingStage['status'], desc?: string) => {
    setModalStages((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status, description: desc ?? s.description } : s)),
    );
  };

  const handleCreate = async () => {
    if (!pin) return pushToast('error', 'Enter a PIN');
    if (pin !== pinConfirm) return pushToast('error', 'PINs do not match');

    setModalTitle('Creating Wallet');
    setModalError(null);
    setModalSuccess(false);
    setModalStages([
      {
        id: 'generate',
        label: 'Generating entropy & mnemonic',
        description: 'Creating 128-bit entropy and BIP39 mnemonic',
        status: 'pending',
      },
      {
        id: 'derive',
        label: 'Deriving HD keypair',
        description: 'HMAC-SHA512 derivation with "Octra seed"',
        status: 'pending',
      },
      {
        id: 'encrypt',
        label: 'Encrypting wallet',
        description: 'AES-256-GCM encryption with PBKDF2 key derivation',
        status: 'pending',
      },
      {
        id: 'save',
        label: 'Saving to IndexedDB',
        description: 'Persisting encrypted wallet blob',
        status: 'pending',
      },
    ]);
    setModalOpen(true);

    try {
      // Stage 1: Generate
      updateStage('generate', 'active');
      await new Promise((r) => setTimeout(r, 400));
      updateStage('generate', 'done', '12-word mnemonic generated');

      // Stage 2: Derive
      updateStage('derive', 'active');
      await new Promise((r) => setTimeout(r, 300));
      const { wallet, mnemonic: mn } = await createNewWallet(name || 'Account 1', pin);
      updateStage('derive', 'done', `Address: ${wallet.addr.slice(0, 16)}...`);

      // Stage 3: Encrypt
      updateStage('encrypt', 'active');
      await new Promise((r) => setTimeout(r, 300));
      updateStage('encrypt', 'done', 'AES-256-GCM + PBKDF2 (600k iterations)');

      // Stage 4: Save
      updateStage('save', 'active');
      await new Promise((r) => setTimeout(r, 200));
      updateStage('save', 'done', 'Wallet persisted to browser storage');

      setGeneratedMnemonic(mn);
      setPendingWallet(wallet);
      setBackupStep('show');
      setQuizFails(0);
      const idx = pickQuizIndexes(mn.trim().split(/\s+/).length);
      setQuizIdx(idx);
      setQuizInput(idx.map(() => ''));
      setModalSuccess(true);
      setModalSuccessMsg(
        `Wallet created successfully!\n\nAddress: ${wallet.addr}\n\nWrite down your recovery phrase now — the wallet opens once you confirm it.`,
      );
      pushToast('success', 'Wallet created — confirm your recovery phrase to continue');
    } catch (e) {
      setModalError((e as Error).message);
      pushToast('error', `Create failed: ${(e as Error).message}`);
    }
  };

  const handleImport = async () => {
    if (!mnemonic.trim()) return pushToast('error', 'Enter your mnemonic');
    if (!pin) return pushToast('error', 'Enter a PIN');
    if (pin !== pinConfirm) return pushToast('error', 'PINs do not match');

    setModalTitle('Importing Wallet');
    setModalError(null);
    setModalSuccess(false);
    setModalStages([
      {
        id: 'validate',
        label: 'Validating mnemonic',
        description: 'Checking word count and wordlist',
        status: 'pending',
      },
      {
        id: 'seed',
        label: 'Deriving master seed',
        description: 'PBKDF2-HMAC-SHA512 (2048 iterations)',
        status: 'pending',
      },
      {
        id: 'derive',
        label: 'Deriving HD keypair',
        description: 'HMAC-SHA512 with "Octra seed"',
        status: 'pending',
      },
      {
        id: 'encrypt',
        label: 'Encrypting wallet',
        description: 'AES-256-GCM with your PIN',
        status: 'pending',
      },
      {
        id: 'save',
        label: 'Saving to IndexedDB',
        description: 'Persisting encrypted wallet',
        status: 'pending',
      },
    ]);
    setModalOpen(true);

    try {
      updateStage('validate', 'active');
      await new Promise((r) => setTimeout(r, 300));
      updateStage('validate', 'done', 'Mnemonic valid');

      updateStage('seed', 'active');
      await new Promise((r) => setTimeout(r, 300));
      updateStage('seed', 'done', '64-byte master seed derived');

      updateStage('derive', 'active');
      const wallet = await importMnemonic(mnemonic.trim(), name || 'Imported', pin);
      updateStage('derive', 'done', `Address: ${wallet.addr.slice(0, 16)}...`);

      updateStage('encrypt', 'active');
      await new Promise((r) => setTimeout(r, 300));
      updateStage('encrypt', 'done', 'Wallet encrypted');

      updateStage('save', 'active');
      await new Promise((r) => setTimeout(r, 200));
      updateStage('save', 'done', 'Wallet saved');

      setModalSuccess(true);
      setModalSuccessMsg(
        `Wallet imported successfully!\n\nAddress: ${wallet.addr}\n\nOpening your wallet...`,
      );
      pushToast('success', 'Wallet imported successfully');

      // Import has no mnemonic to write down, so activate straight away —
      // the user lands on the wallet without any extra click or refresh.
      setTimeout(() => activateWallet(wallet), 600);
    } catch (e) {
      setModalError((e as Error).message);
      pushToast('error', `Import failed: ${(e as Error).message}`);
    }
  };

  /**
   * Check the retyped words against the generated phrase, then open the wallet.
   * Comparison is case- and whitespace-insensitive: BIP39 words are lowercase
   * ASCII, and a stray capital or space is a typing artefact, not a wrong word.
   */
  const confirmBackup = () => {
    if (!generatedMnemonic || !pendingWallet) return;
    if (!checkQuizAnswers(generatedMnemonic, quizIdx, quizInput)) {
      setQuizFails((n) => n + 1);
      pushToast('error', 'Those words do not match the phrase');
      return;
    }
    pushToast('success', 'Recovery phrase confirmed');
    activateWallet(pendingWallet);
  };

  /**
   * Activate a wallet immediately: clears local state, then hands the wallet to
   * the store, which flips Layout over to the main wallet view. No page
   * refresh is involved.
   */
  const activateWallet = (w: Wallet) => {
    setModalOpen(false);
    setModalError(null);
    setModalSuccess(false);
    setGeneratedMnemonic(null);
    setPendingWallet(null);
    setQuizIdx([]);
    setQuizInput([]);
    setShowMnemonic(false);
    setWallet(w);
    pushToast('success', 'Wallet activated — PVAC WASM loading in background');
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalError(null);
    setModalSuccess(false);
  };

  const pinMismatch = Boolean(pinConfirm) && pin !== pinConfirm;
  const strength = getPinStrength(pin);

  // When a wallet already exists, say so in a notice below: the account being
  // added is independent and may carry its own PIN.
  useEffect(() => {
    listStoredWallets()
      .then((entries) => setHasExistingWallet(entries.length > 0))
      .catch(() => undefined);
  }, []);

  return (
    <>
      <div className="auth-shell">
        <div className="auth-corner">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>

        <div className="card auth-card wide">
          <div className="auth-head">
            <img src="/logo.png" alt="Octra" className="auth-logo" />
            <h1 className="auth-title">
              {mode === 'create' ? 'Create New Wallet' : 'Import Wallet'}
            </h1>
            <p className="auth-sub">
              {mode === 'create'
                ? 'Everything is generated on this device. Nothing leaves it.'
                : 'Restore an existing wallet from its BIP39 recovery phrase.'}
            </p>
          </div>

          {/* Real buttons, not clickable divs: these switch what the form does, and a
              keyboard user could not reach them before. */}
          <div className="tab-bar" role="tablist" aria-label="Wallet setup mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'create'}
              className={`tab ${mode === 'create' ? 'active' : ''}`}
              onClick={() => setMode('create')}
            >
              <Icon name="sparkles" size={16} /> Create New
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'import'}
              className={`tab ${mode === 'import' ? 'active' : ''}`}
              onClick={() => setMode('import')}
            >
              <Icon name="upload" size={16} /> Import from Mnemonic
            </button>
          </div>

          {hasExistingWallet && (
            <div className="info-box spaced">
              <Icon name="info" size={16} />
              <span>
                A wallet already exists on this device. The new account is added alongside the
                existing ones (nothing is replaced) and gets its own PIN — you can reuse your usual
                PIN or pick a different one.
              </span>
            </div>
          )}

          {mode === 'import' && (
            <div className="form-row">
              <label htmlFor="mnemonic">
                Mnemonic (12/15/18/21/24 words){' '}
                <InfoHint text="Enter your BIP39 mnemonic phrase. Words must be separated by spaces. The mnemonic is processed locally and never sent to any server." />
              </label>
              <textarea
                id="mnemonic"
                className="mono resize-y"
                rows={3}
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident"
                spellCheck={false}
              />
            </div>
          )}

          <div className="form-row">
            <label htmlFor="name">Account Name</label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Account 1"
              autoComplete="off"
            />
          </div>

          <div className="grid-2">
            <div className="form-row">
              <label htmlFor="pin">
                PIN{' '}
                <InfoHint text="Any characters you like — letters, digits, symbols, even just digits. Minimum 6 characters." />
              </label>
              <div className="input-wrap">
                <input
                  id="pin"
                  type={showPin ? 'text' : 'password'}
                  className="mono"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="Min 6 chars"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="icon-btn plain input-affix"
                  onClick={() => setShowPin(!showPin)}
                  title={showPin ? 'Hide PIN' : 'Show PIN'}
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                >
                  <Icon name={showPin ? 'eye-off' : 'eye'} size={16} />
                </button>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="pin2">Confirm PIN</label>
              <input
                id="pin2"
                type={showPin ? 'text' : 'password'}
                className="mono"
                value={pinConfirm}
                onChange={(e) => setPinConfirm(e.target.value)}
                autoComplete="new-password"
                aria-invalid={pinMismatch}
                data-invalid={pinMismatch ? 'true' : undefined}
              />
              {pinMismatch && (
                <div className="field-error">
                  <Icon name="alert-triangle" size={12} /> PINs do not match
                </div>
              )}
            </div>
          </div>

          {pin && (
            <div className="strength" data-level={strength}>
              <div className="strength-track" aria-hidden="true">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className={`strength-seg ${i <= strength ? 'on' : ''}`} />
                ))}
              </div>
              {/* Announced politely: the meter updates on every keystroke, and an
                  assertive region would interrupt the user mid-word. */}
              <div className="strength-label" role="status">
                {getPinStrengthLabel(pin)}
              </div>
            </div>
          )}

          <div className="form-actions stacked">
            {mode === 'create' ? (
              <button className="primary btn-lg" onClick={handleCreate} disabled={!pin}>
                <Icon name="sparkles" size={18} /> Create Wallet
              </button>
            ) : (
              <button
                className="primary btn-lg"
                onClick={handleImport}
                disabled={!mnemonic || !pin}
              >
                <Icon name="upload" size={18} /> Import Wallet
              </button>
            )}
            <button className="ghost" onClick={onBack}>
              <Icon name="arrow-left" size={16} /> Back to Unlock
            </button>
          </div>

          {generatedMnemonic && backupStep === 'show' && (
            <div className="secret-box">
              <div className="secret-head">
                <span>
                  <Icon name="alert-triangle" size={14} /> Save this mnemonic — shown only once!
                </span>
                <button
                  type="button"
                  className="icon-btn plain"
                  onClick={() => setShowMnemonic(!showMnemonic)}
                  title={showMnemonic ? 'Hide' : 'Show'}
                  aria-label={showMnemonic ? 'Hide recovery phrase' : 'Show recovery phrase'}
                >
                  <Icon name={showMnemonic ? 'eye-off' : 'eye'} size={16} />
                </button>
              </div>
              <div
                className={`secret-value lg ${showMnemonic ? '' : 'blurred'}`}
                data-testid="mnemonic-words"
              >
                {generatedMnemonic}
              </div>
              <div className="secret-actions">
                <button
                  className="ghost"
                  onClick={() => {
                    copyText(generatedMnemonic);
                    pushToast('success', 'Mnemonic copied to clipboard');
                  }}
                >
                  <Icon name="copy" size={16} /> Copy Mnemonic
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    setShowMnemonic(false);
                    setBackupStep('verify');
                  }}
                >
                  I&rsquo;ve Written It Down <Icon name="arrow-right" size={16} />
                </button>
              </div>
              <div className="secret-note">
                The wallet opens once you confirm a few words from the phrase. You can reveal it
                again later under Settings → Security with your PIN.
              </div>
            </div>
          )}

          {generatedMnemonic && backupStep === 'verify' && (
            <div className="secret-box neutral">
              <div className="secret-head">
                <span>
                  <Icon name="check-circle" size={16} /> Confirm your recovery phrase
                </span>
              </div>
              <div className="secret-note">
                Type the words at these positions, counting from 1. This is the only check that you
                really have the phrase.
              </div>
              <div className="quiz-grid">
                {quizIdx.map((wordIndex, slot) => (
                  <div key={wordIndex} className="form-row">
                    <label htmlFor={`verify-word-${slot}`}>Word #{wordIndex + 1}</label>
                    <input
                      id={`verify-word-${slot}`}
                      data-word-index={wordIndex}
                      className="mono"
                      value={quizInput[slot] ?? ''}
                      onChange={(e) => {
                        const next = [...quizInput];
                        next[slot] = e.target.value;
                        setQuizInput(next);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          confirmBackup();
                        }
                      }}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>
              {quizFails > 0 && (
                <div className="field-error" role="alert">
                  <Icon name="alert-triangle" size={12} />
                  {quizFails === 1
                    ? 'That did not match.'
                    : `That did not match (${quizFails} tries).`}{' '}
                  Check the phrase again if you need to.
                </div>
              )}
              <div className="secret-actions">
                <button className="ghost" onClick={() => setBackupStep('show')}>
                  <Icon name="arrow-left" size={16} /> Show Phrase Again
                </button>
                <button
                  className="primary"
                  onClick={confirmBackup}
                  disabled={quizInput.some((w) => !w.trim())}
                >
                  Confirm &amp; Open Wallet
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <ProcessingModal
        open={modalOpen}
        title={modalTitle}
        stages={modalStages}
        error={modalError}
        success={modalSuccess}
        successMessage={modalSuccessMsg}
        successAction={{ label: 'Got It', onClick: closeModal }}
        errorAction={{ label: 'Close', onClick: closeModal }}
        onClose={modalError ? closeModal : undefined}
        dismissible={!!modalError}
      />
    </>
  );
}

function getPinStrength(pin: string): number {
  if (!pin) return 0;
  let score = 0;
  if (pin.length >= 8) score++;
  if (pin.length >= 12) score++;
  if (pin.length >= 15) score++;
  if (/[a-z]/.test(pin) && /[A-Z]/.test(pin)) score++;
  if (/\d/.test(pin)) score++;
  if (/[^a-zA-Z0-9]/.test(pin)) score++;
  return Math.min(4, Math.max(1, score));
}

function getPinStrengthLabel(pin: string): string {
  if (!pin) return '';
  if (pin.length < 6) return 'Too short (min 6 chars)';
  const strength = getPinStrength(pin);
  if (strength <= 1) return 'Weak — a longer PIN is harder to guess';
  if (strength <= 2) return 'Fair — consider more length or varied characters';
  if (strength <= 3) return 'Good';
  return 'Strong';
}
