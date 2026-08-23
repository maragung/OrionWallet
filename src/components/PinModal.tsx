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
import { createPortal } from 'react-dom';
import { recordPinAttempt, resetPinAttempts } from '../wallet/pin';
import { Icon } from './icons/Icon';

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
  /* A PIN typed on a phone keyboard is easy to mistype and impossible to check,
     and the field is the only thing standing between the user and a retry loop. */
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus whenever the modal is (re)opened.
  useEffect(() => {
    if (!open) return;
    setPin('');
    setError(null);
    setBusy(false);
    setReveal(false);
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

  const dialog = (
    <div className="modal-overlay top" onClick={() => !busy && onCancel()}>
      <div
        className="modal-content sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <span className="modal-icon accent">
            <Icon name="lock" size={20} />
          </span>
          <h3 className="modal-title">{title}</h3>
        </div>
        {description && <p className="modal-text">{description}</p>}

        <div className="form-row">
          <label htmlFor="pin-modal-input">PIN</label>
          <div className="input-wrap">
            <input
              id="pin-modal-input"
              ref={inputRef}
              type={reveal ? 'text' : 'password'}
              className="mono"
              autoComplete="current-password"
              value={pin}
              disabled={busy}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            <button
              type="button"
              className="icon-btn plain input-affix"
              onClick={() => setReveal(!reveal)}
              title={reveal ? 'Hide PIN' : 'Show PIN'}
              aria-label={reveal ? 'Hide PIN' : 'Show PIN'}
            >
              <Icon name={reveal ? 'eye-off' : 'eye'} size={18} />
            </button>
          </div>
        </div>

        {error && (
          <div className="info-box err" role="alert">
            <Icon name="alert-triangle" size={18} />
            <span>{error}</span>
          </div>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void submit()} disabled={!pin || busy}>
            {busy ? (
              <>
                <span className="spinner" />
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

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
