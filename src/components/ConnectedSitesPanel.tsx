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
import { Icon } from './icons';

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
        <div className="card-title">
          <Icon name="link" size={18} /> Connected Sites
        </div>
        <button
          className="icon-btn"
          onClick={refresh}
          aria-label="Refresh connected sites"
          disabled={loading}
        >
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={16} />}
        </button>
      </div>

      <p className="card-desc">
        Sites connected via the Wallet SDK. They can read your address, balance, and network, and
        request signatures — every signature still needs your explicit approval. They can never
        send, transfer, swap, bridge, or broadcast.
      </p>

      {sessions.length === 0 ? (
        <div className="empty-note">No active sessions.</div>
      ) : (
        <div className="data-rows">
          {sessions.map((s) => (
            <div key={s.sid} className="data-row">
              <span className="data-row-main">
                <span className="mono truncate">{s.origin}</span>
                <span className="data-row-sub">
                  {timeLeft(Math.min(s.idleExpiresAt, s.absExpiresAt))} · {s.permissions.length}{' '}
                  permissions
                </span>
              </span>
              <button className="ghost danger btn-sm" onClick={() => revoke(s.sid)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card-subhead">
        <Icon name="star" size={16} /> Trusted Sites
      </div>
      <p className="field-note">
        Trusted sites skip only the connection prompt. They never skip a signing prompt.
      </p>
      {trusted.length === 0 ? (
        <div className="empty-note">No trusted sites.</div>
      ) : (
        <div className="data-rows">
          {trusted.map((t) => (
            <div key={t.origin} className="data-row">
              <span className="data-row-main mono truncate">{t.origin}</span>
              <button className="ghost danger btn-sm" onClick={() => untrust(t.origin)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
