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
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitcher } from './LanguageSwitcher';
import { Icon } from './icons';
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
      <div className="auth-shell">
        {/* Theme and language both have to exist before the wallet is open: this is
            the screen a first-time user lands on, and it was the one screen with no
            way out of a theme that is painful to read or a language you cannot
            read at all. */}
        <div className="auth-corner">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>

        <div className="card auth-card">
          <div className="auth-head">
            <img src="/logo.png" alt="Octra" className="auth-logo" />
            <h1 className="auth-title">Welcome Back</h1>
            <p className="auth-sub">Unlock your Octra wallet to continue</p>
          </div>

          {notice && (
            <div className="info-box spaced">
              <Icon name="shield-lock" size={18} />
              <div className="info-box-body">{notice}</div>
            </div>
          )}

          {loadError && (
            <div className="info-box err spaced">
              <Icon name="alert-triangle" size={18} />
              <div className="info-box-body">
                <div>Could not read your saved wallets: {loadError}</div>
                <div>
                  Nothing has been lost — the accounts are still on this device. Close any other
                  Orion tab or connect popup, then try again.
                </div>
                <button
                  className="ghost btn-sm self-start"
                  onClick={() => void handleRetryProbe()}
                  disabled={probing}
                >
                  {probing ? (
                    <>
                      <span className="spinner" /> Checking…
                    </>
                  ) : (
                    <>
                      <Icon name="refresh" size={16} /> Try again
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {hasStored === false && !loadError && (
            <div className="info-box warn spaced">
              <Icon name="info" size={18} />
              <span>No stored wallet found. Create a new wallet to get started.</span>
            </div>
          )}

          {!webCryptoOk && (
            <div className="info-box warn spaced">
              <Icon name="timer" size={18} />
              <span>
                Insecure context — WebCrypto is unavailable, so unlocking falls back to pure JS and
                can take many seconds. Use HTTPS or localhost for fast unlocks.
              </span>
            </div>
          )}

          {storedEntries.length > 1 && (
            <div className="form-row">
              <label htmlFor="unlock-account">Connect with account</label>
              <select
                id="unlock-account"
                className="connect-select"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
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
                className="primary btn-block"
                onClick={() => void handlePasskeyUnlock()}
                disabled={passkeyBusy || unlocking}
                title={`Unlock ${passkey.name} (${passkey.addr.slice(0, 12)}…) with this device`}
              >
                {passkeyBusy ? (
                  <>
                    <span className="spinner" /> Waiting for your device…
                  </>
                ) : (
                  <>
                    <Icon name="fingerprint" size={18} /> Unlock with passkey
                  </>
                )}
              </button>
              {/* Offered first because it is one tap against a PIN that takes a
                  line of typing. It used to sit below the PIN button, under a
                  field that grabbed focus on mount — so the faster route was the
                  one you had to go looking for. */}
              <div className="auth-divider">or use your PIN</div>
            </>
          )}

          <div className="form-row">
            <label htmlFor="pin">
              PIN{' '}
              <Tooltip text="Enter the PIN you set when creating or importing your wallet. The PIN decrypts your locally-stored encrypted wallet.">
                <span className="help-hint">
                  <Icon name="info" size={14} />
                </span>
              </Tooltip>
            </label>
            <div className="input-wrap">
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
              />
              <button
                type="button"
                className="icon-btn input-affix"
                onClick={() => setShowPin(!showPin)}
                title={showPin ? 'Hide PIN' : 'Show PIN'}
                aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
              >
                <Icon name={showPin ? 'eye-off' : 'eye'} size={18} />
              </button>
            </div>
            {pinError && (
              <div id="pin-error" role="alert" className="field-error">
                <Icon name="alert-triangle" size={14} />
                {pinError}
              </div>
            )}
          </div>

          <div className="form-actions stacked">
            <button
              className={passkey ? 'ghost' : 'primary'}
              onClick={() => void handleUnlock()}
              disabled={!pin || unlocking}
            >
              {unlocking ? (
                <>
                  <span className="spinner" /> Unlocking…
                </>
              ) : (
                <>
                  <Icon name="unlock" size={18} /> Unlock Wallet
                </>
              )}
            </button>
            <button className="ghost" onClick={onCreate} disabled={unlocking}>
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
