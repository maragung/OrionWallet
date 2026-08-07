import { describe, it, expect } from 'vitest';
import { normalizeHistoryPage } from '../../src/rpc/client';

/**
 * The History tab must render correctly regardless of which shape the node
 * returns transaction history in. `normalizeHistoryPage` collapses all of them
 * into one `HistoryPage`:
 *
 *   - the official `octra_transactionsByAddress` envelope
 *     { transactions[], rejected[], total, has_more, offset, limit }
 *   - a `{ transactions: [...] }` object with no pagination metadata
 *   - a bare array (oldest / legacy `octra_account` providers)
 *
 * A regression here previously broke History entirely: the client typed the
 * `octra_account` result as `HistoryEntry[]`, but the node returned an object,
 * so `list.map(...)` threw and the panel fell back to "cached / empty".
 */
describe('normalizeHistoryPage', () => {
  it('parses the official paginated envelope', () => {
    const raw = {
      address: 'octX',
      total: 120,
      count: 2,
      offset: 0,
      limit: 50,
      has_more: true,
      transactions: [
        { hash: 'a', from: 'octA', to_: 'octB', amount: '1000000' },
        { hash: 'b', from: 'octA', to_: 'octC', amount: '2000000' },
      ],
      rejected: [],
    };
    const page = normalizeHistoryPage(raw, 50, 0);
    expect(page.transactions).toHaveLength(2);
    expect(page.total).toBe(120);
    expect(page.hasMore).toBe(true);
    expect(page.transactions[0].hash).toBe('a');
  });

  it('merges rejected transactions (audit trail) on the first page only', () => {
    const raw = {
      total: 3,
      has_more: false,
      transactions: [{ hash: 'ok1' }, { hash: 'ok2' }],
      rejected: [{ hash: 'bad1' }],
    };
    const page = normalizeHistoryPage(raw, 50, 0);
    expect(page.transactions).toHaveLength(3);
    // Rejected first, tagged failed.
    expect(page.transactions[0].hash).toBe('bad1');
    expect(page.transactions[0].status).toBe('failed');
    expect(page.transactions[1].status).not.toBe('failed');
  });

  it('does NOT re-inject rejected rows on deeper pages (offset > 0)', () => {
    const raw = {
      total: 100,
      has_more: true,
      transactions: [{ hash: 'ok3' }],
      rejected: [{ hash: 'bad1' }],
    };
    const page = normalizeHistoryPage(raw, 50, 50);
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0].hash).toBe('ok3');
  });

  it('accepts a { transactions } object with no pagination metadata', () => {
    const raw = { transactions: [{ hash: 'x' }, { hash: 'y' }] };
    const page = normalizeHistoryPage(raw, 50, 0);
    expect(page.transactions).toHaveLength(2);
    // No `total` provided → falls back to offset + count.
    expect(page.total).toBe(2);
    // No has_more and total==count → nothing more to load.
    expect(page.hasMore).toBe(false);
  });

  it('accepts a bare array (legacy providers) and infers hasMore from fullness', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ hash: `h${i}` }));
    const page = normalizeHistoryPage(rows, 50, 0);
    expect(page.transactions).toHaveLength(50);
    // A full page implies there may be more.
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(50);
  });

  it('a short bare array implies no more pages', () => {
    const page = normalizeHistoryPage([{ hash: 'h0' }], 50, 0);
    expect(page.hasMore).toBe(false);
  });

  it('maps the legacy `to` field onto `to_`', () => {
    const page = normalizeHistoryPage([{ hash: 'h', to: 'octLegacy' }], 50, 0);
    expect(page.transactions[0].to_).toBe('octLegacy');
  });

  it('reads `tx_hash` when `hash` is absent', () => {
    const page = normalizeHistoryPage([{ tx_hash: 'deadbeef' }], 50, 0);
    expect(page.transactions[0].hash).toBe('deadbeef');
  });

  it('drops non-object rows instead of throwing', () => {
    const page = normalizeHistoryPage([null, 42, 'x', { hash: 'good' }], 50, 0);
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0].hash).toBe('good');
  });

  it('returns an empty page for null / garbage input', () => {
    for (const bad of [null, undefined, 42, 'nope', true]) {
      const page = normalizeHistoryPage(bad, 50, 0);
      expect(page.transactions).toEqual([]);
      expect(page.hasMore).toBe(false);
    }
  });

  it('carries offset/limit through unchanged', () => {
    const page = normalizeHistoryPage({ transactions: [], total: 0 }, 25, 75);
    expect(page.offset).toBe(75);
    expect(page.limit).toBe(25);
  });
});
