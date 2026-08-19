/**
 * Approval prompt components for the SDK connect popup.
 *
 * Each prompt answers one question — "what exactly am I agreeing to?" — and it
 * has to answer it in the two seconds a user actually spends here. So every
 * prompt leads with a plain-language summary of the fields that matter (who is
 * asking, what is being signed, how much it moves, what it costs, which nonce),
 * and keeps the verbatim payload one click away behind "Show raw payload" for
 * anyone who wants to audit it.
 *
 * That split is the whole design. A wall of `JSON.stringify` output looks
 * rigorous and reads as noise: the fields that decide whether to approve are
 * buried among the ones that never change, so in practice people approve without
 * reading. The raw view still exists, because for typed data and contract args it
 * is sometimes the only complete answer — it just is not the default.
 *
 * They deliberately reuse the wallet's existing modal/token styling (CSS vars) so
 * the popup feels native to the wallet.
 *
 * There is one prompt per approvable action; a discriminated union drives which
 * one renders. `connect` optionally lets the user mark the origin trusted (skip
 * only the connect prompt next time — never the signing prompt).
 */
import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, ApprovalDecision } from '../rpc-handler';
import { formatAmount } from '../../tx/builder';

export type { ApprovalDecision };

export interface SelectableAccount {
  address: string;
  name?: string;
  index?: number;
}

interface Props {
  request: ApprovalRequest;
  onDecision: (d: ApprovalDecision) => void;
  busy?: boolean;
  /** Accounts to choose between for a `connect` prompt (multi-account). */
  accounts?: SelectableAccount[];
  /** Currently selected account for the connect prompt. */
  selectedAccount?: string | null;
  /** Called when the user picks a different account in the connect prompt. */
  onSelectAccount?: (address: string) => void;
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

/** One label/value line in a summary. `mono` for hashes, addresses, and amounts. */
function Row({
  label,
  value,
  mono = true,
  emphasis = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-2) 0',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 'var(--fs-sm)',
        alignItems: 'baseline',
      }}
    >
      <span style={{ flex: '0 0 34%', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
        {label}
      </span>
      <span
        className={mono ? 'mono' : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          wordBreak: 'break-word',
          color: emphasis ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: emphasis ? 'var(--fw-semibold)' : 'var(--fw-normal)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** Wrapper for the label/value rows, so the last row has no dangling border. */
function Summary({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--sp-2)' }}>
      <style>{`.approval-summary > div:last-child { border-bottom: none; }`}</style>
      <div className="approval-summary">{children}</div>
    </div>
  );
}

/**
 * Collapsed verbatim payload.
 *
 * Closed by default: it is the audit trail, not the summary. Kept in the DOM only
 * when open so a long typed-data blob does not make the popup scroll before the
 * user has even read the question.
 */
function RawPayload({ value, label = 'Show raw payload' }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 'var(--sp-2)' }}>
      <button
        type="button"
        className="ghost"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          fontSize: 'var(--fs-xs)',
          padding: 'var(--sp-1) 0',
          color: 'var(--text-muted)',
          minHeight: 'auto',
        }}
      >
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div style={card}>{safeJson(value)}</div>}
    </div>
  );
}

/**
 * Stringify a payload for display without ever throwing in the render path.
 *
 * dApp-supplied values reach this: a bigint or a circular reference would make
 * `JSON.stringify` throw, and an exception here would blank the prompt — leaving
 * a request the user can neither read nor reject.
 */
function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_k, v: unknown) => {
        if (typeof v === 'bigint') return `${v.toString()}n`;
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

/** Middle-truncate a long value (address, program id) but keep both ends. */
function short(value: string, head = 12, tail = 8): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Render a call argument compactly: strings bare, everything else as JSON. */
function argText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'bigint') return arg.toString();
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === 'object') return safeJson(arg).replace(/\s+/g, ' ');
  return String(arg);
}

/** `amount` in OCT, or a dash when there is nothing to show. */
function octAmount(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '—';
  const formatted = formatAmount(raw);
  return `${formatted} OCT`;
}

function Actions({
  onDecision,
  busy,
  confirmLabel,
  danger,
  rejectRef,
}: {
  onDecision: (d: ApprovalDecision) => void;
  busy?: boolean;
  confirmLabel: string;
  danger?: boolean;
  /** Focused on mount, so a stray Enter rejects rather than signs. */
  rejectRef?: React.Ref<HTMLButtonElement>;
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
      <button
        ref={rejectRef}
        className="ghost"
        disabled={busy}
        onClick={() => onDecision({ approved: false })}
      >
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

export function ApprovalPrompt({
  request,
  onDecision,
  busy,
  accounts,
  selectedAccount,
  onSelectAccount,
}: Props) {
  const [trust, setTrust] = useState(false);
  const { kind, origin, detail } = request;
  const rejectRef = useRef<HTMLButtonElement>(null);

  /**
   * Reject is what gets keyboard focus, not Approve.
   *
   * A popup that steals focus mid-keystroke turns whatever the user was typing
   * into a signature if the default button is Approve. Focusing Reject makes the
   * accidental outcome the safe one; approving stays a deliberate click or Tab.
   */
  useEffect(() => {
    if (!busy) rejectRef.current?.focus();
  }, [busy, kind]);

  /** Escape rejects. Nothing on this prompt should require reaching for a mouse. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onDecision({ approved: false });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onDecision]);

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
      case 'signTransfer':
        return 'Sign Transfer';
    }
  })();

  const showAccountPicker = kind === 'connect' && !!accounts && accounts.length > 1;

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

          {showAccountPicker && (
            <div style={{ marginTop: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
              <label
                htmlFor="connect-account"
                style={{
                  display: 'block',
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--text-muted)',
                  marginBottom: 'var(--sp-2)',
                }}
              >
                Connect with account
              </label>
              <select
                id="connect-account"
                className="connect-select"
                value={selectedAccount ?? ''}
                onChange={(e) => onSelectAccount?.(e.target.value)}
                style={{ width: '100%' }}
              >
                {accounts!.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.name || `Account ${a.index ?? 0}`} ({a.address.slice(0, 10)}…
                    {a.address.slice(-6)})
                  </option>
                ))}
              </select>
            </div>
          )}

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
            rejectRef={rejectRef}
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
          {detail.scheme === 'raw' && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning)', marginTop: 6 }}>
              ⚠ Untagged signature (<span className="mono">raw</span> scheme). Only sign this if you
              recognise the site and know why it needs an untagged signature.
            </p>
          )}
          <Actions confirmLabel="Sign" busy={busy} rejectRef={rejectRef} onDecision={onDecision} />
        </>
      )}

      {kind === 'signTypedData' && (
        <>
          <TypedDataSummary typedData={detail.typedData} />
          <RawPayload value={detail.typedData} label="Show raw typed data" />
          <Actions confirmLabel="Sign" busy={busy} rejectRef={rejectRef} onDecision={onDecision} />
        </>
      )}

      {kind === 'approveContract' && (
        <>
          <Summary>
            <Row label="Program" value={short(String(detail.program ?? ''))} emphasis />
            <Row label="Method" value={String(detail.method ?? '')} emphasis />
            {detail.spender ? <Row label="Spender" value={short(String(detail.spender))} /> : null}
            {detail.limit !== undefined && detail.limit !== null ? (
              <Row label="Limit" value={octAmount(detail.limit)} emphasis />
            ) : (
              <Row label="Limit" value="No limit set by the site" mono={false} />
            )}
            {typeof detail.expiry === 'number' ? (
              <Row label="Expires" value={new Date(detail.expiry * 1000).toLocaleString()} />
            ) : (
              <Row label="Expires" value="Never" mono={false} />
            )}
            <ArgRows args={detail.args} />
          </Summary>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
            You are signing an approval object. It is not submitted here — the site must submit it
            through the wallet.
          </p>
          <RawPayload value={detail} />
          <Actions
            confirmLabel="Approve"
            busy={busy}
            danger
            rejectRef={rejectRef}
            onDecision={onDecision}
          />
        </>
      )}

      {kind === 'signContract' && (
        <>
          <Summary>
            <Row label="Program" value={short(String(detail.program ?? ''))} emphasis />
            <Row label="Method" value={String(detail.method ?? '')} emphasis />
            <Row label="Sends" value={octAmount(detail.amount ?? '0')} emphasis />
            <Row label="Fee" value={octAmount(detail.ou)} />
            <Row label="Nonce" value={String(detail.nonce ?? '—')} />
            <Row label="Operation" value={String(detail.opType ?? 'program_call')} />
            <ArgRows args={detail.args} />
          </Summary>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
            The wallet signs this program call and returns it to the site. Broadcasting only happens
            inside the wallet UI.
          </p>
          <RawPayload value={detail} />
          <Actions
            confirmLabel="Sign"
            busy={busy}
            danger
            rejectRef={rejectRef}
            onDecision={onDecision}
          />
        </>
      )}

      {kind === 'signTransfer' && (
        <>
          <div
            style={{
              textAlign: 'center',
              padding: 'var(--sp-3) 0 var(--sp-2)',
              fontSize: 'var(--fs-xl)',
              fontWeight: 'var(--fw-bold)',
            }}
            className="mono"
          >
            {octAmount(detail.amountRaw ?? detail.amount)}
          </div>
          <Summary>
            <Row label="To" value={String(detail.to ?? '')} emphasis />
            <Row label="Fee" value={octAmount(detail.ou)} />
            <Row label="Nonce" value={String(detail.nonce ?? '—')} />
            {detail.message ? (
              <Row label="Memo" value={String(detail.message)} mono={false} />
            ) : null}
          </Summary>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
            The wallet signs this transfer and hands it back to the site — it does not send it. Only
            approve if you expect {origin} to move this amount.
          </p>
          <RawPayload value={detail} />
          <Actions
            confirmLabel="Sign transfer"
            busy={busy}
            danger
            rejectRef={rejectRef}
            onDecision={onDecision}
          />
        </>
      )}
    </div>
  );
}

/** Call arguments as one row per argument, or a single row saying there are none. */
function ArgRows({ args }: { args: unknown }) {
  if (!Array.isArray(args) || args.length === 0) {
    return <Row label="Arguments" value="None" mono={false} />;
  }
  return (
    <>
      {args.map((a, i) => (
        <Row key={i} label={i === 0 ? `Arguments (${args.length})` : ''} value={argText(a)} />
      ))}
    </>
  );
}

/**
 * Typed data as its domain plus the top-level fields of the message.
 *
 * The signature covers the whole structure, so the raw view stays available —
 * but "which app, which type, which values" is what tells a user whether this is
 * the order they just placed, and that fits on screen.
 */
function TypedDataSummary({ typedData }: { typedData: unknown }) {
  const td = (typedData ?? {}) as {
    domain?: { name?: string; version?: string; chainId?: string };
    primaryType?: string;
    message?: Record<string, unknown>;
  };
  const message = td.message && typeof td.message === 'object' ? td.message : {};
  const entries = Object.entries(message);
  return (
    <Summary>
      <Row label="App" value={String(td.domain?.name ?? 'Unnamed')} mono={false} emphasis />
      {td.domain?.version ? <Row label="Version" value={String(td.domain.version)} /> : null}
      {td.domain?.chainId ? <Row label="Chain" value={String(td.domain.chainId)} /> : null}
      <Row label="Type" value={String(td.primaryType ?? '—')} emphasis />
      {entries.length === 0 ? (
        <Row label="Message" value="Empty" mono={false} />
      ) : (
        entries.map(([k, v]) => <Row key={k} label={k} value={argText(v)} />)
      )}
    </Summary>
  );
}
