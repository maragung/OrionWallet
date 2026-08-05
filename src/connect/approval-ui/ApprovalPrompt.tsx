/**
 * Approval prompt components for the SDK connect popup.
 *
 * Each prompt renders the exact payload the dApp asked to be signed, plus
 * Approve / Reject actions. They deliberately reuse the wallet's existing
 * modal/token styling (CSS vars) so the popup feels native to the wallet.
 *
 * There is one prompt per approvable action; a discriminated union drives which
 * one renders. `connect` optionally lets the user mark the origin trusted (skip
 * only the connect prompt next time — never the signing prompt).
 */
import { useState } from 'react';
import type { ApprovalRequest } from '../rpc-handler';

export interface ApprovalDecision {
  approved: boolean;
  /** Only meaningful for `connect`: persist origin as trusted. */
  trust?: boolean;
}

interface Props {
  request: ApprovalRequest;
  onDecision: (d: ApprovalDecision) => void;
  busy?: boolean;
}

const card: React.CSSProperties = {
  background: 'var(--bg-elevated-2)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-md)',
  padding: 'var(--sp-3)',
  fontSize: 'var(--fs-xs)',
  fontFamily: 'var(--font-mono)',
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
  maxHeight: 220,
  overflowY: 'auto',
};

function OriginBadge({ origin }: { origin: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        marginBottom: 'var(--sp-3)',
      }}
    >
      <span style={{ fontSize: 18 }}>🌐</span>
      <span className="mono" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
        {origin}
      </span>
    </div>
  );
}

function Actions({
  onDecision,
  busy,
  confirmLabel,
  danger,
}: {
  onDecision: (d: ApprovalDecision) => void;
  busy?: boolean;
  confirmLabel: string;
  danger?: boolean;
  trust?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--sp-2)',
        justifyContent: 'flex-end',
        marginTop: 'var(--sp-4)',
      }}
    >
      <button className="ghost" disabled={busy} onClick={() => onDecision({ approved: false })}>
        Reject
      </button>
      <button
        className={danger ? 'danger' : 'primary'}
        disabled={busy}
        onClick={() => onDecision({ approved: true })}
      >
        {busy ? <span className="spinner" /> : confirmLabel}
      </button>
    </div>
  );
}

export function ApprovalPrompt({ request, onDecision, busy }: Props) {
  const [trust, setTrust] = useState(false);
  const { kind, origin, detail } = request;

  const title = (() => {
    switch (kind) {
      case 'connect':
        return 'Connection Request';
      case 'signMessage':
        return 'Sign Message';
      case 'signTypedData':
        return 'Sign Typed Data';
      case 'approveContract':
        return 'Approve Contract';
      case 'signContract':
        return 'Sign Contract Call';
    }
  })();

  return (
    <div
      className="card"
      style={{ maxWidth: 420, width: '100%', margin: '0 auto', boxShadow: 'var(--shadow-xl)' }}
    >
      <div className="card-header">
        <div className="card-title">{title}</div>
      </div>

      <OriginBadge origin={origin} />

      {kind === 'connect' && (
        <>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
            This site wants to connect to your wallet. It will be able to view your address,
            balance, and network, and to <strong>request</strong> signatures. It can never move
            funds or broadcast transactions — every signature needs your explicit approval.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sp-2)',
              marginTop: 'var(--sp-3)',
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            Trust this site (skip only this connection prompt next time)
          </label>
          <Actions
            confirmLabel="Connect"
            busy={busy}
            onDecision={(d) => onDecision({ ...d, trust })}
          />
        </>
      )}

      {kind === 'signMessage' && (
        <>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            Message
          </div>
          <div style={card}>{String(detail.message ?? '')}</div>
          <Actions confirmLabel="Sign" busy={busy} onDecision={onDecision} />
        </>
      )}

      {kind === 'signTypedData' && (
        <>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            Typed data
          </div>
          <div style={card}>{JSON.stringify(detail.typedData, null, 2)}</div>
          <Actions confirmLabel="Sign" busy={busy} onDecision={onDecision} />
        </>
      )}

      {kind === 'approveContract' && (
        <>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            Approval
          </div>
          <div style={card}>{JSON.stringify(detail, null, 2)}</div>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
            You are signing an approval object. It is not submitted here — the site must submit it
            through the wallet.
          </p>
          <Actions confirmLabel="Approve" busy={busy} danger onDecision={onDecision} />
        </>
      )}

      {kind === 'signContract' && (
        <>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            Contract call (will be signed, NOT broadcast)
          </div>
          <div style={card}>{JSON.stringify(detail, null, 2)}</div>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
            The wallet signs this program call and returns it to the site. Broadcasting only happens
            inside the wallet UI.
          </p>
          <Actions confirmLabel="Sign" busy={busy} danger onDecision={onDecision} />
        </>
      )}
    </div>
  );
}
