/**
 * PinModal — a small, focused modal that asks for the wallet PIN.
 *
 * Used by flows that need to re-derive signing keys (e.g. switching the active
 * account) without sending the user back through the full unlock screen. It is
 * a `position: fixed` overlay, so whatever is underneath stays mounted and
 * visible instead of being replaced by a blank page.
 *
 * `onSubmit` should reject/throw with a human-readable message on failure; the
 * message is rendered inline and the modal stays open so the user can retry.
 */
import { useEffect, useRef, useState } from 'react';
import { recordPinAttempt, resetPinAttempts } from '../wallet/pin';

export function PinModal({
  open,
  title = 'Enter PIN',
  description,
  confirmLabel = 'Unlock',
  busyLabel = 'Unlocking…',
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  busyLabel?: string;
  onSubmit: (pin: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus whenever the modal is (re)opened.
  useEffect(() => {
    if (!open) return;
    setPin('');
    setError(null);
    setBusy(false);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  // Escape cancels, unless a submit is in flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const submit = async () => {
    if (!pin || busy) return;
    if (!recordPinAttempt('pin-modal')) {
      setError('Too many failed attempts. Please wait 30 seconds before trying again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pin);
      resetPinAttempts('pin-modal');
      setPin('');
    } catch (e) {
      const msg = (e as Error).message ?? 'Unlock failed';
      setError(
        msg.toLowerCase().includes('decryption failed') || msg.toLowerCase().includes('pin')
          ? 'Wrong PIN. Please try again.'
          : msg,
      );
      setPin('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={() => !busy && onCancel()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3000,
        padding: 'var(--sp-4)',
        animation: 'fadeIn var(--t-base)',
      }}
    >
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated-1)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--sp-6)',
          maxWidth: 400,
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          animation: 'slideUp var(--t-base)',
        }}
      >
        <div className="card-title" style={{ marginBottom: 'var(--sp-2)' }}>
          {title}
        </div>
        {description && (
          <p
            style={{
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-secondary)',
              marginTop: 0,
              marginBottom: 'var(--sp-4)',
            }}
          >
            {description}
          </p>
        )}

        <div className="form-row">
          <label htmlFor="pin-modal-input">PIN</label>
          <input
            id="pin-modal-input"
            ref={inputRef}
            type="password"
            className="mono"
            autoComplete="current-password"
            value={pin}
            disabled={busy}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </div>

        {error && (
          <div
            style={{
              color: 'var(--error)',
              background: 'var(--error-soft)',
              borderRadius: 'var(--r-md)',
              padding: 'var(--sp-3)',
              fontSize: 'var(--fs-sm)',
              marginTop: 'var(--sp-2)',
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: 'var(--sp-2)',
            justifyContent: 'flex-end',
            marginTop: 'var(--sp-4)',
          }}
        >
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void submit()} disabled={!pin || busy}>
            {busy ? (
              <>
                <span className="spinner" style={{ marginRight: 6 }} />
                {busyLabel}
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
