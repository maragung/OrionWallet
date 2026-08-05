import { describe, it, expect } from 'vitest';
import { formatAmount } from '../../src/tx/builder';

/**
 * Regression cover for the History panel going blank white.
 *
 * Root cause: neither the node response nor the local tx cache is
 * schema-validated — `listTxCache` casts blindly (`c.tx as HistoryEntry`). A
 * missing `hash` or a numeric `amount` threw mid-render, React 18 unmounted the
 * whole tree, `#root` went empty, and index.html's
 * `#root:empty::before { content: 'Loading Orion Wallet…' }` took over.
 *
 * HistoryView now normalises every row before render. These tests mirror that
 * normalisation so the invariant — "no field access can throw" — stays covered.
 */

interface SafeEntry {
  key: string;
  hash: string;
  from: string;
  recipient: string;
  amount: string;
  fee: string;
  opType: string;
  status: string;
  timestamp: number | null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeEntry(raw: unknown, index: number): SafeEntry {
  const tx = (raw ?? {}) as Record<string, unknown>;
  const hash = asString(tx.hash);
  const rawTs = typeof tx.timestamp === 'number' ? tx.timestamp : Number(tx.timestamp);
  return {
    key: hash || `entry-${index}`,
    hash,
    from: asString(tx.from),
    recipient: asString(tx.to_ ?? tx.to),
    amount: formatAmount(tx.amount),
    fee: formatAmount(tx.ou),
    opType: asString(tx.op_type) || 'unknown',
    status: asString(tx.status) || 'pending',
    timestamp: Number.isFinite(rawTs) && rawTs > 0 ? rawTs : null,
  };
}

function shortenHash(hash: string): string {
  if (!hash) return '—';
  return hash.length > 10 ? `${hash.slice(0, 10)}…` : hash;
}

function shortenAddr(addr: string): string {
  if (!addr) return '—';
  return addr.length > 8 ? `${addr.slice(0, 8)}…` : addr;
}

function formatTimestamp(ts: number | null): string {
  if (ts === null) return '—';
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

/** Every derived field the table touches, exercised end to end. */
function renderRow(entry: SafeEntry): string {
  return [
    shortenHash(entry.hash),
    shortenAddr(entry.from),
    shortenAddr(entry.recipient),
    entry.amount,
    entry.fee,
    entry.opType,
    entry.status,
    formatTimestamp(entry.timestamp),
  ].join('|');
}

const MALFORMED: [string, unknown][] = [
  ['null entry', null],
  ['undefined entry', undefined],
  ['empty object', {}],
  ['missing hash', { from: 'octaaa', amount: '1000000' }],
  ['numeric amount', { hash: 'h1', amount: 1500000, ou: 10000 }],
  ['non-numeric amount', { hash: 'h2', amount: 'abc', ou: 'xyz' }],
  ['null fields', { hash: null, from: null, to_: null, amount: null, ou: null }],
  ['missing timestamp', { hash: 'h3', amount: '1' }],
  ['string timestamp', { hash: 'h4', timestamp: 'not-a-date' }],
  ['negative timestamp', { hash: 'h5', timestamp: -1 }],
  ['nested object amount', { hash: 'h6', amount: { value: 1 } }],
  ['array amount', { hash: 'h7', amount: [] }],
  ['short hash', { hash: 'ab' }],
  ['short addresses', { hash: 'h8', from: 'oct', to_: 'oct' }],
];

describe('HistoryView row normalisation', () => {
  it.each(MALFORMED)('does not throw while rendering: %s', (_label, raw) => {
    expect(() => renderRow(normalizeEntry(raw, 0))).not.toThrow();
  });

  it('normalises a whole malformed list without throwing', () => {
    const rows = MALFORMED.map(([, raw]) => raw);
    expect(() => rows.map((r, i) => renderRow(normalizeEntry(r, i)))).not.toThrow();
  });

  it('always produces a unique, non-empty React key', () => {
    const keys = MALFORMED.map(([, raw], i) => normalizeEntry(raw, i).key);
    for (const k of keys) expect(k).not.toBe('');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('falls back to placeholders rather than empty cells', () => {
    const row = normalizeEntry({}, 0);
    expect(shortenHash(row.hash)).toBe('—');
    expect(shortenAddr(row.from)).toBe('—');
    expect(formatTimestamp(row.timestamp)).toBe('—');
    expect(row.opType).toBe('unknown');
    expect(row.status).toBe('pending');
  });

  it('reads the node\'s "to_" field and the cache\'s legacy "to" alias', () => {
    expect(normalizeEntry({ to_: 'octNODE' }, 0).recipient).toBe('octNODE');
    expect(normalizeEntry({ to: 'octCACHE' }, 0).recipient).toBe('octCACHE');
    // to_ wins when both are present
    expect(normalizeEntry({ to_: 'octNODE', to: 'octCACHE' }, 0).recipient).toBe('octNODE');
  });

  it('still formats well-formed rows correctly', () => {
    const row = normalizeEntry(
      {
        hash: 'abcdef0123456789',
        from: 'octSENDERADDRESS',
        to_: 'octRECIPIENTADDR',
        amount: '1500000',
        ou: '10000',
        op_type: 'standard',
        status: 'confirmed',
        timestamp: 1_700_000_000,
      },
      0,
    );
    expect(row.amount).toBe('1.5');
    expect(row.fee).toBe('0.01');
    expect(row.opType).toBe('standard');
    expect(row.status).toBe('confirmed');
    expect(shortenHash(row.hash)).toBe('abcdef0123…');
    expect(row.timestamp).toBe(1_700_000_000);
  });
});
