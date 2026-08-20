import { useEffect } from 'react';
import { Icon, type IconName } from './icons/Icon';

/**
 * Reusable confirmation dialog — for destructive or important actions.
 *
 * Features:
 *   - Icon + title + message
 *   - Confirm/Cancel buttons (customizable labels)
 *   - Optional "danger" variant (red confirm button)
 *   - ESC to cancel, Enter to confirm
 *
 * Usage:
 *   <ConfirmDialog
 *     open={true}
 *     title="Remove Account"
 *     message="Are you sure you want to remove this account? This cannot be undone."
 *     confirmLabel="Remove"
 *     danger
 *     onConfirm={() => removeAccount()}
 *     onCancel={() => setShowConfirm(false)}
 *   />
 */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * Which glyph sits in the badge. A name from the wallet's own icon set rather
   * than free text, so a caller cannot ship an emoji that renders differently on
   * every OS — and so the badge tint can be derived from `danger` instead of
   * being guessed from the character.
   */
  icon?: IconName;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional: additional details shown in a code block */
  details?: string;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  icon = 'alert-triangle',
  onConfirm,
  onCancel,
  details,
}: ConfirmDialogProps) {
  // ESC to cancel
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <span className={`modal-icon ${danger ? 'danger' : ''}`}>
            <Icon name={icon} size={20} />
          </span>
          <h3 className="modal-title">{title}</h3>
        </div>

        <p className="modal-text">{message}</p>

        {details && <div className="modal-details mono">{details}</div>}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Reusable alert dialog — for showing informational messages.
 */
interface AlertDialogProps {
  open: boolean;
  title: string;
  message: string;
  icon?: IconName;
  label?: string;
  onClose: () => void;
}

export function AlertDialog({
  open,
  title,
  message,
  icon = 'info',
  label = 'OK',
  onClose,
}: AlertDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <span className="modal-icon accent">
            <Icon name={icon} size={20} />
          </span>
          <h3 className="modal-title">{title}</h3>
        </div>

        <p className="modal-text">{message}</p>

        <div className="modal-actions">
          <button className="primary" onClick={onClose} autoFocus>
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}
