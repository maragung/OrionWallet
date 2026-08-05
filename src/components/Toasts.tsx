import { useWalletStore } from '../store/wallet-store';

export function Toasts() {
  const { toasts, dismissToast } = useWalletStore();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.level}`}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)' }}
        >
          <div className="toast-msg" style={{ flex: 1, minWidth: 0 }}>
            {t.message}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(t.id);
            }}
            aria-label="Close notification"
            title="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 16,
              padding: '0 var(--sp-2)',
              minHeight: 32,
              minWidth: 32,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
