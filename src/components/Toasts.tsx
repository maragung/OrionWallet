import { useWalletStore } from '../store/wallet-store';
import { Icon, type IconName } from './icons/Icon';

/**
 * Severity glyph per level. The level is also carried by the toast's left border
 * colour and, for anything the user must act on, by the message text itself — the
 * icon is a third, redundant signal rather than the only one.
 */
const TOAST_ICON: Record<string, IconName> = {
  success: 'check-circle',
  error: 'alert-octagon',
  warning: 'alert-triangle',
  info: 'info',
};

export function Toasts() {
  const { toasts, dismissToast } = useWalletStore();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span className="toast-icon">
            <Icon name={TOAST_ICON[t.level] ?? 'info'} size={18} />
          </span>
          <div className="toast-msg">{t.message}</div>
          <button
            type="button"
            className="icon-btn plain"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(t.id);
            }}
            aria-label="Close notification"
            title="Close"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
