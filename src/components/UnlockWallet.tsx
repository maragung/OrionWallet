import { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { unlockWallet, listStoredWallets } from '../api/wallet-api';
import { recordPinAttempt, resetPinAttempts } from '../wallet/pin';
import { isWebCryptoAvailable } from '../crypto/aes';
import {
  getPasskeyInfo,
  isPasskeySupported,
  unlockWithPasskey,
  type PasskeyInfo,
} from '../wallet/passkey';
import { ProcessingModal, type ProcessingStage } from './ProcessingModal';
import { Tooltip } from './Tooltip';
import { closeDb, type StoredWalletEntry } from '../wallet/storage';

export interface UnlockWalletProps {
  onCreate: () => void;
  /**
   * Why the wallet is being asked to unlock, when something other than the user
   * asked. Rendered above the PIN field.
   *
   * The connect popup uses this to name the site that is waiting. An unexplained
   * PIN prompt has the same shape as a phishing prompt, and the right instinct
   * when facing one of those is to close the window — so without this the safest
   * user behaviour is also the one that loses the request.
   */
  notice?: React.ReactNode;
}

export function UnlockWallet({ onCreate, notice }: UnlockWalletProps) {
  const { setWallet, pushToast } = useWalletStore();
  const [pin, setPin] = useState('');
  /**
   * True from the moment an unlock starts until it resolves.
   *
   * PBKDF2 runs for seconds, and Enter in the PIN field is the fastest way to
   * start one. Without a guard, a second Enter spends another `recordPinAttempt`
   * slot on a PIN that is already being checked — so two impatient keystrokes
   * burn two of the very few attempts allowed before the 30-second lockout.
   */
  const [unlocking, setUnlocking] = useState(false);
  /** Field-level complaint, shown next to the input instead of as a toast. */
  const [pinError, setPinError] = useState<string | null>(null);
  // `null` means "not known yet or unreadable" — never "none saved".
  const [hasStored, setHasStored] = useState<boolean | null>(null);
  const [storedEntries, setStoredEntries] = useState<StoredWalletEntry[]>([]);
  /** Why the stored-wallet list could not be read, if it could not. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('default');
  const [showPin, setShowPin] = useState(false);
  // Insecure contexts have no crypto.subtle: PBKDF2 runs in JS and unlock is slow.
  const webCryptoOk = isWebCryptoAvailable();
  // Passkey unlock, when the user set one up on this device.
  const [passkey, setPasskey] = useState<PasskeyInfo | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  // Processing modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStages, setModalStages] = useState<ProcessingStage[]>([]);
  const [modalError, setModalError] = useState<string | null>(null);

  /**
   * Read the saved wallets, keeping "none saved" and "could not read" apart.
   *
   * The two look the same to a user but mean opposite things: the first invites
   * creating a wallet, the second means existing accounts are momentarily
   * unreachable — a blocked IndexedDB upgrade, usually another wallet tab still
   * holding the database. Reporting the second as the first is what made saved
   * accounts look lost, and sent people into the create flow over their wallet.
   */
  const probeStored = useCallback(async () => {
    setProbing(true);
    try {
      const list = await listStoredWallets();
      setStoredEntries(list);
      setHasStored(list.length > 0);
      setLoadError(null);
      // Always default to the main wallet entry ("default" sorts before
      // "acct-..." in key order, but never rely on that ordering).
      const def = list.find((e) => e.id === 'default');
      if (def) setSelectedId(def.id);
      else if (list.length > 0) setSelectedId(list[0].id);
    } catch (e) {
      setHasStored(null);
      setStoredEntries([]);
      setLoadError((e as Error).message);
    } finally {
      setProbing(false);
    }
    // Same storage, so a failed read leaves the passkey unknown too. Re-probing
    // it here keeps the retry a single action for the user.
    if (isPasskeySupported()) setPasskey(await getPasskeyInfo().catch(() => null));
  }, []);

  useEffect(() => {
    void probeStored();
  }, [probeStored]);

  const handleRetryProbe = async () => {
    // Drop the cached connection first: reusing the handle that just failed
    // reproduces the same failure.
    await closeDb();
    await probeStored();
  };

  const handlePasskeyUnlock = async () => {
    setPasskeyBusy(true);
    try {
      const wallet = await unlockWithPasskey();
      pushToast('success', `Unlocked ${wallet.name || 'wallet'} with your passkey`);
      setWallet(wallet);
      resetPinAttempts('unlock');
    } catch (e) {
      pushToast('error', `Passkey unlock failed: ${(e as Error).message}`);
      // The record self-destructs when it can no longer be opened, so re-read
      // it instead of leaving a button that will fail the same way again.
      setPasskey(await getPasskeyInfo().catch(() => null));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const updateStage = (id: string, status: ProcessingStage['status'], desc?: string) => {
    setModalStages((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status, description: desc ?? s.description } : s)),
    );
  };

  const handleUnlock = async () => {
    // Re-entry guard, not a nicety: see the note on `unlocking`.
    if (unlocking) return;
    if (!pin) {
      setPinError('Enter your PIN to unlock.');
      return;
    }

    if (!recordPinAttempt('unlock')) {
      setPinError('Too many failed attempts. Wait 30 seconds, then try again.');
      return;
    }

    setPinError(null);
    setModalError(null);
    setUnlocking(true);
    // Two stages, because two things actually happen. There used to be four,
    // two of which were marked done the instant they appeared — and 500ms of
    // `setTimeout` was inserted between them so the fake progress would be
    // visible. Unlock now takes exactly as long as the cryptography takes.
    setModalStages([
      {
        id: 'decrypt',
        label: 'Checking your PIN',
        description: 'PBKDF2 key derivation + AES-256-GCM decryption',
        status: 'pending',
      },
      {
        id: 'load',
        label: 'Opening your wallet',
        description: 'Restoring keys and address',
        status: 'pending',
      },
    ]);
    setModalOpen(true);

    try {
      updateStage('decrypt', 'active');
      // No blanket timeout here: unlockWallet bounds its own storage read, and
      // PBKDF2 (600k iterations) legitimately takes seconds on the pure-JS
      // fallback used when crypto.subtle is unavailable.
      const wallet = await unlockWallet(pin, selectedId);
      updateStage('decrypt', 'done', 'PIN accepted');

      updateStage('load', 'active');
      updateStage('load', 'done', `Address: ${wallet.addr.slice(0, 16)}…`);

      // Close this modal BEFORE flipping `isUnlocked`. Once the store flips,
      // Layout swaps to the main app and unmounts this component (and its
      // modal), so any await sequenced after `setWallet` would be pointless.
      setModalOpen(false);
      // Names the wallet that opened. The network and FHE module keep loading in
      // the background, but that is the wallet's business, not something to
      // announce to someone who just wanted in.
      pushToast('success', `Unlocked ${wallet.name || 'wallet'}`);
      setWallet(wallet);
      resetPinAttempts('unlock');
    } catch (e) {
      const msg = (e as Error).message;
      updateStage('decrypt', 'error');
      // Reported once, in the modal that is already open and already showing
      // which step failed. The same text as a toast on top of it was two copies
      // of one problem, in two places, with two different dismiss behaviours.
      setModalError(
        msg.includes('decryption failed')
          ? 'Wrong PIN. Please check your PIN and try again.'
          : `Unlock failed: ${msg}`,
      );
    } finally {
      setUnlocking(false);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalError(null);
  };

  // Main wallet entry first, then derived accounts in stable key order.
  const orderedEntries = [...storedEntries].sort((a, b) =>
    a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id),
  );

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

          {notice && (
            <div
              className="info-box"
              style={{
                marginBottom: 'var(--sp-4)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--sp-2)',
                fontSize: 'var(--fs-sm)',
              }}
            >
              <span>🔒</span>
              <div style={{ flex: 1, minWidth: 0 }}>{notice}</div>
            </div>
          )}

          {loadError && (
            <div
              className="info-box err"
              style={{
                marginBottom: 'var(--sp-4)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--sp-2)',
              }}
            >
              <span>⚠️</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>Could not read your saved wallets: {loadError}</div>
                <div style={{ marginTop: 'var(--sp-1)' }}>
                  Nothing has been lost — the accounts are still on this device. Close any other
                  Orion tab or connect popup, then try again.
                </div>
                <button
                  className="ghost"
                  onClick={() => void handleRetryProbe()}
                  disabled={probing}
                  style={{ marginTop: 'var(--sp-2)', minHeight: 32 }}
                >
                  {probing ? (
                    <>
                      <span className="spinner" /> Checking…
                    </>
                  ) : (
                    <>↻ Try again</>
                  )}
                </button>
              </div>
            </div>
          )}

          {hasStored === false && !loadError && (
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

          {!webCryptoOk && (
            <div
              className="info-box warn"
              style={{
                marginBottom: 'var(--sp-4)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--sp-2)',
              }}
            >
              <span>🐌</span>
              <span>
                Insecure context — WebCrypto is unavailable, so unlocking falls back to pure JS and
                can take many seconds. Use HTTPS or localhost for fast unlocks.
              </span>
            </div>
          )}

          {storedEntries.length > 1 && (
            <div className="form-row" style={{ marginBottom: 'var(--sp-3)' }}>
              <label htmlFor="unlock-account">Connect with account</label>
              <select
                id="unlock-account"
                className="connect-select"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                style={{ width: '100%' }}
              >
                {orderedEntries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.addrHint})
                  </option>
                ))}
              </select>
            </div>
          )}

          {passkey && (
            <>
              <button
                className="primary"
                onClick={() => void handlePasskeyUnlock()}
                disabled={passkeyBusy || unlocking}
                title={`Unlock ${passkey.name} (${passkey.addr.slice(0, 12)}…) with this device`}
                style={{ width: '100%' }}
              >
                {passkeyBusy ? (
                  <>
                    <span className="spinner" /> Waiting for your device…
                  </>
                ) : (
                  <>👆 Unlock with passkey</>
                )}
              </button>
              {/* Offered first because it is one tap against a PIN that takes a
                  line of typing. It used to sit below the PIN button, under a
                  field that grabbed focus on mount — so the faster route was the
                  one you had to go looking for. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-2)',
                  margin: 'var(--sp-4) 0 var(--sp-3)',
                  color: 'var(--text-muted)',
                  fontSize: 'var(--fs-xs)',
                }}
              >
                <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                or use your PIN
                <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
              </div>
            </>
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
                onChange={(e) => {
                  setPin(e.target.value);
                  // The complaint was about what was in the box; typing answers it.
                  if (pinError) setPinError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && void handleUnlock()}
                placeholder="Enter your wallet PIN"
                // Not focused when a passkey exists: the passkey is the primary
                // action there, and stealing the caret into a PIN field argues
                // for the slower route.
                autoFocus={!passkey}
                autoComplete="current-password"
                aria-invalid={pinError ? true : undefined}
                aria-describedby={pinError ? 'pin-error' : undefined}
                disabled={unlocking}
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
            {pinError && (
              <div
                id="pin-error"
                role="alert"
                style={{
                  marginTop: 'var(--sp-2)',
                  color: 'var(--error)',
                  fontSize: 'var(--fs-xs)',
                }}
              >
                {pinError}
              </div>
            )}
          </div>

          <div
            className="form-actions"
            style={{ flexDirection: 'column', marginTop: 'var(--sp-6)' }}
          >
            <button
              className={passkey ? 'ghost' : 'primary'}
              onClick={() => void handleUnlock()}
              disabled={!pin || unlocking}
              style={{ width: '100%' }}
            >
              {unlocking ? (
                <>
                  <span className="spinner" /> Unlocking…
                </>
              ) : (
                <>🔓 Unlock Wallet</>
              )}
            </button>
            <button
              className="ghost"
              onClick={onCreate}
              disabled={unlocking}
              style={{ width: '100%', marginTop: 'var(--sp-2)' }}
            >
              Create New Wallet
            </button>
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
      </div>
    </>
  );
}
