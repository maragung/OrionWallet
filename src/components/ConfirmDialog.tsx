import { useEffect } from 'react';

/**
 * Reusable confirmation dialog — for destructive or important actions.
 *
 * Features:
 *   - Icon + title + message
 *   - Confirm/Cancel buttons (customizable labels)
 *   - Optional "danger" variant (red confirm button)
 *   - Optional input field (e.g., for typing "DELETE" to confirm)
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
  icon?: string;
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
  icon = '⚠️',
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
    <div
      className="modal-overlay"
      onClick={onCancel}
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
          maxWidth: 440,
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          animation: 'slideUp var(--t-base)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--sp-3)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: danger ? 'var(--error-soft)' : 'var(--warning-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', margin: 0 }}>
              {title}
            </h3>
          </div>
        </div>

        <p
          style={{
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-secondary)',
            marginBottom: 'var(--sp-4)',
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>

        {details && (
          <div
            className="mono"
            style={{
              padding: 'var(--sp-3)',
              background: 'var(--bg-elevated-2)',
              borderRadius: 'var(--r-md)',
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-muted)',
              marginBottom: 'var(--sp-4)',
              wordBreak: 'break-all',
              maxHeight: 200,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {details}
          </div>
        )}

        <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
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
  icon?: string;
  label?: string;
  onClose: () => void;
}

export function AlertDialog({
  open,
  title,
  message,
  icon = 'ℹ️',
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
    <div
      className="modal-overlay"
      onClick={onClose}
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
          maxWidth: 440,
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          animation: 'slideUp var(--t-base)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--sp-3)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: 'var(--accent-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', margin: 0 }}>
              {title}
            </h3>
          </div>
        </div>

        <p
          style={{
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-secondary)',
            marginBottom: 'var(--sp-4)',
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>

        <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          <button className="primary" onClick={onClose} autoFocus>
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}
