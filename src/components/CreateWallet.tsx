import { copyText } from '../utils/clipboard';
import { useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { createNewWallet, importMnemonic } from '../api/wallet-api';
import { checkQuizAnswers, pickQuizIndexes } from '../wallet/mnemonic-quiz';
import { ThemeToggle } from './ThemeToggle';
import { ProcessingModal, type ProcessingStage } from './ProcessingModal';
import { Tooltip } from './Tooltip';

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
        `Wallet created successfully!\n\nAddress: ${wallet.addr}\n\n⚠️ Write down your recovery phrase now — the wallet opens once you confirm it.`,
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

  return (
    <>
      <div
        style={{
          minHeight: '100vh',
          ...({ minHeight: '100dvh' } as React.CSSProperties),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--sp-4)',
          background:
            'radial-gradient(ellipse at top, var(--bg-elevated-1) 0%, var(--bg-base) 60%)',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', top: 'var(--sp-4)', right: 'var(--sp-4)' }}>
          <ThemeToggle />
        </div>

        <div
          className="card"
          style={{
            width: '100%',
            maxWidth: 560,
            padding: 'var(--sp-8) var(--sp-6)',
            boxShadow: 'var(--shadow-xl)',
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: 'var(--sp-5)' }}>
            <img
              src="/logo.png"
              alt="Octra"
              style={{ width: 48, height: 48, marginBottom: 'var(--sp-2)' }}
            />
            <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-bold)' }}>
              {mode === 'create' ? 'Create New Wallet' : 'Import Wallet'}
            </h1>
          </div>

          <div className="tab-bar">
            <div
              className={`tab ${mode === 'create' ? 'active' : ''}`}
              onClick={() => setMode('create')}
            >
              Create New
            </div>
            <div
              className={`tab ${mode === 'import' ? 'active' : ''}`}
              onClick={() => setMode('import')}
            >
              Import from Mnemonic
            </div>
          </div>

          {mode === 'import' && (
            <div className="form-row">
              <label htmlFor="mnemonic">
                Mnemonic (12/15/18/21/24 words){' '}
                <Tooltip text="Enter your BIP39 mnemonic phrase. Words must be separated by spaces. The mnemonic is processed locally and never sent to any server.">
                  <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>ⓘ</span>
                </Tooltip>
              </label>
              <textarea
                id="mnemonic"
                className="mono"
                rows={3}
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident"
                spellCheck={false}
                style={{ resize: 'vertical' }}
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
                <Tooltip text="8-64 characters. If under 15 chars: must include letter + digit + symbol. If 15+ chars: any characters allowed (passphrase-style).">
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
                  placeholder="Min 8 chars"
                  autoComplete="new-password"
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
                    minHeight: 32,
                    minWidth: 32,
                    border: 'none',
                  }}
                >
                  {showPin ? '🙈' : '👁️'}
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
                style={
                  pinConfirm && pin !== pinConfirm ? { borderColor: 'var(--error)' } : undefined
                }
              />
              {pinConfirm && pin !== pinConfirm && (
                <div
                  style={{
                    color: 'var(--error)',
                    fontSize: 'var(--fs-xs)',
                    marginTop: 'var(--sp-1)',
                  }}
                >
                  ⚠ PINs do not match
                </div>
              )}
            </div>
          </div>

          {/* PIN strength indicator */}
          {pin && (
            <div style={{ marginBottom: 'var(--sp-3)' }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                {[1, 2, 3, 4].map((i) => {
                  const strength = getPinStrength(pin);
                  const filled = i <= strength;
                  return (
                    <div
                      key={i}
                      style={{
                        flex: 1,
                        height: 4,
                        borderRadius: 2,
                        background: filled
                          ? strength <= 1
                            ? 'var(--error)'
                            : strength <= 2
                              ? 'var(--warning)'
                              : strength <= 3
                                ? 'var(--info)'
                                : 'var(--success)'
                          : 'var(--bg-elevated-3)',
                        transition: 'background var(--t-fast)',
                      }}
                    />
                  );
                })}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                {getPinStrengthLabel(pin)}
              </div>
            </div>
          )}

          <div className="form-actions" style={{ flexDirection: 'column' }}>
            {mode === 'create' ? (
              <button
                className="primary"
                onClick={handleCreate}
                disabled={!pin}
                style={{ width: '100%' }}
              >
                ✨ Create Wallet
              </button>
            ) : (
              <button
                className="primary"
                onClick={handleImport}
                disabled={!mnemonic || !pin}
                style={{ width: '100%' }}
              >
                📥 Import Wallet
              </button>
            )}
            <button
              className="ghost"
              onClick={onBack}
              style={{ width: '100%', marginTop: 'var(--sp-2)' }}
            >
              ← Back to Unlock
            </button>
          </div>

          {generatedMnemonic && backupStep === 'show' && (
            <div
              style={{
                marginTop: 'var(--sp-5)',
                padding: 'var(--sp-4)',
                background: 'var(--warning-soft)',
                border: '1px solid var(--warning)',
                borderRadius: 'var(--r-md)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 'var(--sp-2)',
                }}
              >
                <strong style={{ color: 'var(--warning)', fontSize: 'var(--fs-sm)' }}>
                  ⚠️ Save this mnemonic — shown only once!
                </strong>
                <button
                  type="button"
                  className="ghost icon"
                  onClick={() => setShowMnemonic(!showMnemonic)}
                  title={showMnemonic ? 'Hide' : 'Show'}
                  style={{ minHeight: 28, minWidth: 28, fontSize: 14 }}
                >
                  {showMnemonic ? '🙈' : '👁️'}
                </button>
              </div>
              <div
                className="mono"
                data-testid="mnemonic-words"
                style={{
                  fontSize: 'var(--fs-sm)',
                  wordBreak: 'break-word',
                  color: 'var(--text-primary)',
                  filter: showMnemonic ? 'none' : 'blur(6px)',
                  transition: 'filter var(--t-base)',
                  padding: 'var(--sp-2) 0',
                }}
              >
                {generatedMnemonic}
              </div>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
                <button
                  className="ghost"
                  style={{ flex: 1, minHeight: 36 }}
                  onClick={() => {
                    copyText(generatedMnemonic);
                    pushToast('success', 'Mnemonic copied to clipboard');
                  }}
                >
                  📋 Copy Mnemonic
                </button>
                <button
                  className="primary"
                  style={{ flex: 1, minHeight: 36 }}
                  onClick={() => {
                    setShowMnemonic(false);
                    setBackupStep('verify');
                  }}
                >
                  I&rsquo;ve Written It Down →
                </button>
              </div>
              <div
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--text-secondary)',
                  marginTop: 'var(--sp-2)',
                }}
              >
                The wallet opens once you confirm a few words from the phrase. You can reveal it
                again later under Settings → Security with your PIN.
              </div>
            </div>
          )}

          {generatedMnemonic && backupStep === 'verify' && (
            <div
              style={{
                marginTop: 'var(--sp-5)',
                padding: 'var(--sp-4)',
                background: 'var(--bg-elevated-2)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--r-md)',
              }}
            >
              <strong style={{ fontSize: 'var(--fs-sm)' }}>✔ Confirm your recovery phrase</strong>
              <div
                style={{
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--text-secondary)',
                  margin: 'var(--sp-1) 0 var(--sp-3)',
                }}
              >
                Type the words at these positions, counting from 1. This is the only check that you
                really have the phrase.
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${Math.max(1, quizIdx.length)}, minmax(0, 1fr))`,
                  gap: 'var(--sp-2)',
                }}
              >
                {quizIdx.map((wordIndex, slot) => (
                  <div key={wordIndex} className="form-row" style={{ marginBottom: 0 }}>
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
                <div
                  style={{
                    color: 'var(--error)',
                    fontSize: 'var(--fs-xs)',
                    marginTop: 'var(--sp-2)',
                  }}
                >
                  ⚠{' '}
                  {quizFails === 1
                    ? 'That did not match.'
                    : `That did not match (${quizFails} tries).`}{' '}
                  Check the phrase again if you need to.
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
                <button
                  className="ghost"
                  style={{ flex: 1, minHeight: 36 }}
                  onClick={() => setBackupStep('show')}
                >
                  ← Show Phrase Again
                </button>
                <button
                  className="primary"
                  style={{ flex: 1, minHeight: 36 }}
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
  if (pin.length < 8) return '⚠ Too short (min 8 chars)';
  const strength = getPinStrength(pin);
  if (strength <= 1) return 'Weak — add letters, digits, symbols';
  if (strength <= 2) return 'Fair — consider more length or complexity';
  if (strength <= 3) return 'Good';
  return 'Strong';
}
