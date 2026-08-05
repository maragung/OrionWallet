/**
 * Connected-sites & trusted-sites management for the wallet Settings screen.
 *
 * Lets the user:
 *   - See dApp origins with a live SDK session and revoke them.
 *   - See and remove trusted sites (which skip only the connect prompt).
 */
import { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import {
  listSdkSessions,
  deleteSdkSession,
  listTrustedSites,
  removeTrustedSite,
  type SdkSessionRecord,
  type TrustedSiteRecord,
} from '../wallet/storage';

function timeLeft(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return 'expired';
  const min = Math.floor(d / 60000);
  if (min < 60) return `${min}m left`;
  return `${Math.floor(min / 60)}h ${min % 60}m left`;
}

export function ConnectedSitesPanel() {
  const { pushToast } = useWalletStore();
  const [sessions, setSessions] = useState<SdkSessionRecord[]>([]);
  const [trusted, setTrusted] = useState<TrustedSiteRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([listSdkSessions(), listTrustedSites()]);
      const now = Date.now();
      setSessions(s.filter((x) => x.absExpiresAt > now && x.idleExpiresAt > now));
      setTrusted(t);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const revoke = async (sid: string) => {
    await deleteSdkSession(sid);
    pushToast('success', 'Session revoked');
    refresh();
  };

  const untrust = async (origin: string) => {
    await removeTrustedSite(origin);
    pushToast('success', `Removed trust for ${origin}`);
    refresh();
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">🔗 Connected Sites</div>
        <button className="ghost icon" onClick={refresh} aria-label="Refresh" disabled={loading}>
          {loading ? <span className="spinner" /> : '↻'}
        </button>
      </div>

      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
        Sites connected via the Wallet SDK. They can read your address, balance, and network, and
        request signatures — every signature still needs your explicit approval. They can never
        send, transfer, swap, bridge, or broadcast.
      </p>

      {sessions.length === 0 ? (
        <div
          style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', padding: 'var(--sp-3) 0' }}
        >
          No active sessions.
        </div>
      ) : (
        sessions.map((s) => (
          <div
            key={s.sid}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--sp-2)',
              padding: 'var(--sp-2) 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="mono" style={{ fontSize: 'var(--fs-sm)' }}>
                {s.origin}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                {timeLeft(Math.min(s.idleExpiresAt, s.absExpiresAt))} · {s.permissions.length}{' '}
                permissions
              </div>
            </div>
            <button className="ghost" onClick={() => revoke(s.sid)} style={{ minHeight: 32 }}>
              Revoke
            </button>
          </div>
        ))
      )}

      <div className="card-header" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="card-title" style={{ fontSize: 'var(--fs-sm)' }}>
          ⭐ Trusted Sites
        </div>
      </div>
      <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        Trusted sites skip only the connection prompt. They never skip a signing prompt.
      </p>
      {trusted.length === 0 ? (
        <div
          style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', padding: 'var(--sp-2) 0' }}
        >
          No trusted sites.
        </div>
      ) : (
        trusted.map((t) => (
          <div
            key={t.origin}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--sp-2)',
              padding: 'var(--sp-2) 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div className="mono" style={{ fontSize: 'var(--fs-sm)', minWidth: 0 }}>
              {t.origin}
            </div>
            <button className="ghost" onClick={() => untrust(t.origin)} style={{ minHeight: 32 }}>
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  );
}
