import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { unlockWallet, listStoredWallets } from '../api/wallet-api';
import { recordPinAttempt, resetPinAttempts } from '../wallet/pin';
import { ThemeToggle } from './ThemeToggle';
import { ProcessingModal, type ProcessingStage } from './ProcessingModal';
import { Tooltip } from './Tooltip';

export function UnlockWallet({ onCreate }: { onCreate: () => void }) {
  const { setWallet, pushToast } = useWalletStore();
  const [pin, setPin] = useState('');
  const [hasStored, setHasStored] = useState<boolean | null>(null);
  const [showPin, setShowPin] = useState(false);

  // Processing modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStages, setModalStages] = useState<ProcessingStage[]>([]);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    listStoredWallets()
      .then((list) => setHasStored(list.length > 0))
      .catch(() => setHasStored(false));
  }, []);

  const updateStage = (id: string, status: ProcessingStage['status'], desc?: string) => {
    setModalStages((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status, description: desc ?? s.description } : s)),
    );
  };

  const handleUnlock = async () => {
    if (!pin) {
      pushToast('error', 'Please enter your PIN');
      return;
    }

    if (!recordPinAttempt('unlock')) {
      pushToast('error', 'Too many failed attempts. Please wait 30 seconds before trying again.');
      return;
    }

    setModalError(null);
    setModalStages([
      {
        id: 'decrypt',
        label: 'Decrypting wallet',
        description: 'PBKDF2 key derivation + AES-256-GCM decryption',
        status: 'pending',
      },
      {
        id: 'load',
        label: 'Loading wallet data',
        description: 'Restoring keys and address',
        status: 'pending',
      },
      {
        id: 'pvac',
        label: 'Loading PVAC WASM',
        description: 'Initializing FHE module for encrypted balance',
        status: 'pending',
      },
      {
        id: 'rpc',
        label: 'Connecting to network',
        description: 'Initializing RPC client',
        status: 'pending',
      },
    ]);
    setModalOpen(true);

    try {
      // Stage 1: Decrypt
      updateStage('decrypt', 'active');
      await new Promise((r) => setTimeout(r, 200));
      const wallet = await unlockWallet(pin);
      updateStage('decrypt', 'done', 'Wallet decrypted successfully');

      // Stage 2: Load
      updateStage('load', 'active');
      await new Promise((r) => setTimeout(r, 150));
      updateStage('load', 'done', `Address: ${wallet.addr.slice(0, 16)}...`);

      // Stages 3 & 4 are handed off to the store: `setWallet` kicks off the
      // PVAC WASM load and the RPC init in the background, and drives the
      // global LoadingOverlay while RPC comes up.
      updateStage('pvac', 'done', 'PVAC WASM loading in background');
      updateStage('rpc', 'done', 'Connecting in background');
      await new Promise((r) => setTimeout(r, 150));

      // Close this modal BEFORE flipping `isUnlocked`. Once the store flips,
      // Layout swaps to the main app and unmounts this component (and its
      // modal), so any await sequenced after `setWallet` would be pointless.
      setModalOpen(false);
      pushToast('success', 'Wallet unlocked — PVAC WASM loading in background');
      setWallet(wallet);
      resetPinAttempts('unlock');
    } catch (e) {
      const msg = (e as Error).message;
      updateStage('decrypt', 'error');
      setModalError(
        msg.includes('decryption failed')
          ? 'Wrong PIN. Please check your PIN and try again.'
          : `Unlock failed: ${msg}`,
      );
      pushToast('error', `Unlock failed: ${msg}`);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalError(null);
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
            maxWidth: 420,
            padding: 'var(--sp-8) var(--sp-6)',
            boxShadow: 'var(--shadow-xl)',
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: 'var(--sp-6)' }}>
            <img
              src="/logo.png"
              alt="Octra"
              style={{ width: 56, height: 56, marginBottom: 'var(--sp-3)' }}
            />
            <h1
              style={{
                fontSize: 'var(--fs-xl)',
                fontWeight: 'var(--fw-bold)',
                marginBottom: 'var(--sp-1)',
              }}
            >
              Welcome Back
            </h1>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
              Unlock your Octra wallet to continue
            </p>
          </div>

          {hasStored === false && (
            <div
              className="info-box warn"
              style={{
                marginBottom: 'var(--sp-4)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-2)',
              }}
            >
              <span>ℹ️</span>
              <span>No stored wallet found. Create a new wallet to get started.</span>
            </div>
          )}

          <div className="form-row">
            <label htmlFor="pin">
              PIN{' '}
              <Tooltip text="Enter the PIN you set when creating or importing your wallet. The PIN decrypts your locally-stored encrypted wallet.">
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
                onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                placeholder="Enter your wallet PIN"
                autoFocus
                autoComplete="current-password"
                style={{ paddingRight: 48 }}
              />
              <button
                type="button"
                className="ghost icon"
                onClick={() => setShowPin(!showPin)}
                title={showPin ? 'Hide PIN' : 'Show PIN'}
                aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
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

          <div
            className="form-actions"
            style={{ flexDirection: 'column', marginTop: 'var(--sp-6)' }}
          >
            <button
              className="primary"
              onClick={handleUnlock}
              disabled={!pin}
              style={{ width: '100%' }}
            >
              🔓 Unlock Wallet
            </button>
            <button
              className="ghost"
              onClick={onCreate}
              style={{ width: '100%', marginTop: 'var(--sp-2)' }}
            >
              Create New Wallet
            </button>
          </div>

          <div className="info-box" style={{ marginTop: 'var(--sp-6)', fontSize: 'var(--fs-xs)' }}>
            <strong>PIN requirements:</strong>
            <br />
            • 8–64 characters
            <br />• Under 15 chars: letter + digit + symbol
          </div>

          <div style={{ marginTop: 'var(--sp-4)', textAlign: 'center' }}>
            <a
              href="https://orionwallet.vercel.app/docs"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}
            >
              📖 Documentation
            </a>
          </div>
        </div>
      </div>

      <ProcessingModal
        open={modalOpen}
        title="Unlocking Wallet"
        stages={modalStages}
        error={modalError}
        errorAction={{ label: 'Try Again', onClick: closeModal }}
        onClose={closeModal}
        dismissible={!!modalError}
      />
    </>
  );
}
