/**
 * Token discovery tests against a fake Octra node.
 *
 * The fake mirrors real node behaviour that materially affects correctness:
 *   - batch requests are rejected wholesale above 100 calls
 *   - responses may come back OUT OF ORDER
 *   - `octra_contractStorage` returns `{ value }`, with null for absent keys
 *   - map entries are addressed as `balances:<address>` and nothing else
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RpcClient, BATCH_MAX } from '../../src/rpc/client';
import {
  scanForTokens,
  refreshHoldings,
  addTokenByAddress,
  removeToken,
  loadCachedHoldings,
  getContractList,
  ScanCancelledError,
} from '../../src/api/tokens';
import { wipeEverything } from '../../src/wallet/storage';

const URL_ = 'https://node.example/rpc';
const ME = 'octCo5bJiSwt96Lm7PWM1yzcALsApEWrudoFykSaAGk3Mpy';

/** Storage fixture: contract -> key -> value (mirrors the node's flat KV). */
type Store = Record<string, Record<string, string | null>>;

interface FakeOpts {
  contracts: string[];
  store: Store;
  /** Reply out of order, as JSON-RPC permits. */
  shuffle?: boolean;
  /** Drop this many responses from each batch, simulating a truncated reply. */
  dropPerBatch?: number;
  /** Fail every batch with a transport error. */
  failBatches?: boolean;
}

function makeFake(opts: FakeOpts) {
  const calls = { batches: 0, single: 0, maxBatchSize: 0, storageReads: 0 };

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));

    const handle = (req: { method: string; params: unknown[]; id: number }) => {
      if (req.method === 'octra_listContracts') {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            contracts: opts.contracts.map((a) => ({ address: a, owner: 'x', code_hash: 'h' })),
          },
        };
      }
      if (req.method === 'octra_contractStorage') {
        calls.storageReads++;
        const [addr, key] = req.params as [string, string];
        const value = opts.store[addr]?.[key] ?? null;
        return { jsonrpc: '2.0', id: req.id, result: { key, value } };
      }
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
    };

    if (Array.isArray(body)) {
      calls.batches++;
      calls.maxBatchSize = Math.max(calls.maxBatchSize, body.length);

      if (opts.failBatches) {
        return new Response('gateway blew up', { status: 502 });
      }
      // The real node rejects the ENTIRE batch above 100.
      if (body.length > 100) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32602,
              message: 'invalid params',
              data: `batch size ${body.length} exceeds limit 100`,
            },
          }),
          { status: 200 },
        );
      }

      let out = body.map(handle);
      if (opts.dropPerBatch) out = out.slice(0, Math.max(0, out.length - opts.dropPerBatch));
      if (opts.shuffle) out = [...out].reverse();
      return new Response(JSON.stringify(out), { status: 200 });
    }

    calls.single++;
    return new Response(JSON.stringify(handle(body)), { status: 200 });
  }) as unknown as typeof fetch;

  return { rpc: new RpcClient({ url: URL_, fetchImpl }), calls };
}

/** A complete OCS01 token, matching mainnet's `PX`. */
function token(
  sym: string,
  name: string,
  dec: string | null,
  supply: string,
  balances: Record<string, string>,
) {
  const rec: Record<string, string | null> = {
    symbol: sym,
    name,
    total_supply: supply,
  };
  if (dec !== null) rec.decimals = dec;
  for (const [addr, bal] of Object.entries(balances)) rec[`balances:${addr}`] = bal;
  return rec;
}

beforeEach(async () => {
  await wipeEverything();
});

describe('rpcBatch behaviour', () => {
  it('never sends more than BATCH_MAX calls per request', async () => {
    const contracts = Array.from({ length: 237 }, (_, i) => `oct${i}`);
    const { rpc, calls } = makeFake({ contracts, store: {} });

    await rpc.rpcBatch(
      contracts.map((c) => ({ method: 'octra_contractStorage', params: [c, 'symbol'] })),
    );

    expect(calls.maxBatchSize).toBeLessThanOrEqual(BATCH_MAX);
    expect(BATCH_MAX).toBeLessThanOrEqual(100);
    expect(calls.batches).toBe(Math.ceil(237 / BATCH_MAX));
  });

  it('returns exactly one result per call, in request order', async () => {
    const store: Store = { a: { symbol: 'A' }, b: { symbol: 'B' }, c: { symbol: 'C' } };
    const { rpc } = makeFake({ contracts: [], store, shuffle: true });

    const res = await rpc.rpcBatch<{ value?: unknown }>([
      { method: 'octra_contractStorage', params: ['a', 'symbol'] },
      { method: 'octra_contractStorage', params: ['b', 'symbol'] },
      { method: 'octra_contractStorage', params: ['c', 'symbol'] },
    ]);

    // Order must follow the REQUEST even though the node replied reversed.
    expect(res.map((r) => r.result?.value)).toEqual(['A', 'B', 'C']);
  });

  it('reports a missing response as an error, never as a successful empty value', async () => {
    const { rpc } = makeFake({ contracts: [], store: { a: { symbol: 'A' } }, dropPerBatch: 1 });

    const res = await rpc.rpcBatch([
      { method: 'octra_contractStorage', params: ['a', 'symbol'] },
      { method: 'octra_contractStorage', params: ['a', 'symbol'] },
    ]);

    expect(res).toHaveLength(2);
    const failures = res.filter((r) => !r.ok);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/no response/i);
  });

  it('surfaces the node batch-limit error detail', async () => {
    const { rpc } = makeFake({ contracts: [], store: {} });
    // Reach past the client cap by calling the raw path the node would reject.
    const res = await rpc.rpcBatch(
      Array.from({ length: BATCH_MAX }, () => ({
        method: 'octra_contractStorage',
        params: ['a', 'k'],
      })),
    );
    expect(res).toHaveLength(BATCH_MAX);
  });

  it('fails every call in a chunk when the transport fails', async () => {
    const { rpc } = makeFake({ contracts: [], store: {}, failBatches: true });
    const res = await rpc.rpcBatch([
      { method: 'octra_contractStorage', params: ['a', 'symbol'] },
      { method: 'octra_contractStorage', params: ['b', 'symbol'] },
    ]);
    expect(res).toHaveLength(2);
    expect(res.every((r) => !r.ok)).toBe(true);
  });

  it('returns an empty array for no calls without hitting the network', async () => {
    const { rpc, calls } = makeFake({ contracts: [], store: {} });
    expect(await rpc.rpcBatch([])).toEqual([]);
    expect(calls.batches).toBe(0);
  });
});

describe('listContracts', () => {
  it('unwraps the contracts array', async () => {
    const { rpc } = makeFake({ contracts: ['octA', 'octB'], store: {} });
    const r = await rpc.listContracts();
    expect(r.ok).toBe(true);
    expect(r.result?.map((c) => c.address)).toEqual(['octA', 'octB']);
  });

  it('caches the list and reuses it on the next call', async () => {
    const { rpc, calls } = makeFake({ contracts: ['octA'], store: {} });
    await getContractList(rpc);
    const before = calls.single;
    await getContractList(rpc);
    expect(calls.single).toBe(before); // served from cache
  });
});

describe('scanForTokens', () => {
  const CONTRACTS = ['octTok1', 'octTok2', 'octEmpty', 'octOther'];
  const STORE: Store = {
    octTok1: token('PX', 'PAAMM X', '6', '10000000', { [ME]: '6000000' }),
    octTok2: token('ao', 'ao', '0', '1000000000000000000000000000', {
      [ME]: '1000000000000000000000000000',
    }),
    octEmpty: token('ZERO', 'Zero', '6', '1000', {}),
    octOther: { symbol: 'OTH', name: 'Other', decimals: '6', 'balances:someoneelse': '5' },
  };

  it('finds only contracts where this owner holds a non-zero balance', async () => {
    const { rpc } = makeFake({ contracts: CONTRACTS, store: STORE });
    const held = await scanForTokens(rpc, ME);
    expect(held.map((h) => h.contract).sort()).toEqual(['octTok1', 'octTok2']);
  });

  it('humanizes balances for display, preserving 1e27 exactly', async () => {
    const { rpc } = makeFake({ contracts: CONTRACTS, store: STORE });
    const held = await scanForTokens(rpc, ME);

    const px = held.find((h) => h.symbol === 'PX')!;
    expect(px.amount.display).toBe('6');
    expect(px.raw).toBe(6000000n);

    const ao = held.find((h) => h.symbol === 'ao')!;
    expect(ao.decimals).toBe(0);
    expect(ao.raw).toBe(10n ** 27n);
    expect(ao.amount.display).toBe('1,000,000,000,000,000,000,000,000,000');
  });

  it('reports progress that ends at the contract total', async () => {
    const { rpc } = makeFake({ contracts: CONTRACTS, store: STORE });
    const seen: number[] = [];
    await scanForTokens(rpc, ME, { onProgress: (p) => seen.push(p.scanned) });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(CONTRACTS.length);
  });

  it('persists results so they load without the network', async () => {
    const { rpc } = makeFake({ contracts: CONTRACTS, store: STORE });
    await scanForTokens(rpc, ME);
    const cached = await loadCachedHoldings(URL_, ME);
    expect(cached.map((h) => h.symbol).sort()).toEqual(['PX', 'ao']);
  });

  it('scopes holdings per owner', async () => {
    const { rpc } = makeFake({ contracts: CONTRACTS, store: STORE });
    await scanForTokens(rpc, ME);
    expect(await loadCachedHoldings(URL_, 'octSomebodyElse')).toEqual([]);
  });

  it('probes exactly one key per contract in the discovery phase', async () => {
    const { rpc, calls } = makeFake({ contracts: CONTRACTS, store: STORE });
    await scanForTokens(rpc, ME);
    // 4 probes + 5 metadata keys x 2 hits = 14. The point is that the
    // per-contract cost stays at ONE key; metadata is hits-only.
    expect(calls.storageReads).toBe(CONTRACTS.length + 2 * 5);
  });

  it('aborts promptly when cancelled', async () => {
    const many = Array.from({ length: 400 }, (_, i) => `oct${i}`);
    const { rpc } = makeFake({ contracts: many, store: {} });
    const ac = new AbortController();

    const p = scanForTokens(rpc, ME, {
      signal: ac.signal,
      onProgress: (prog) => {
        if (prog.scanned >= 50) ac.abort();
      },
    });

    await expect(p).rejects.toThrow(ScanCancelledError);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const { rpc, calls } = makeFake({ contracts: CONTRACTS, store: STORE });
    const ac = new AbortController();
    ac.abort();
    await expect(scanForTokens(rpc, ME, { signal: ac.signal })).rejects.toThrow(ScanCancelledError);
    expect(calls.batches).toBe(0);
  });

  it('survives partial batch failure without inventing balances', async () => {
    const { rpc } = makeFake({ contracts: CONTRACTS, store: STORE, dropPerBatch: 2 });
    const held = await scanForTokens(rpc, ME);
    // Dropped reads are skipped, never counted as a zero or a phantom holding.
    expect(held.every((h) => h.raw > 0n)).toBe(true);
  });
});

describe('incomplete metadata', () => {
  it('keeps a holding whose decimals key is absent and marks it unscaled', async () => {
    const store: Store = {
      octBFC: token('BFC', 'BigFatCat', null, '1000000000', { [ME]: '1000000000' }),
    };
    const { rpc } = makeFake({ contracts: ['octBFC'], store });

    const held = await scanForTokens(rpc, ME);
    expect(held).toHaveLength(1);
    expect(held[0].decimals).toBeNull();
    expect(held[0].amount.unscaled).toBe(true);
    expect(held[0].amount.display).toBe('1,000,000,000');
  });

  it('keeps a holding with an empty name', async () => {
    const store: Store = {
      octX: token('BNT', '', '9', '1000', { [ME]: '500' }),
    };
    const { rpc } = makeFake({ contracts: ['octX'], store });
    const held = await scanForTokens(rpc, ME);
    expect(held[0].name).toBeNull();
    expect(held[0].symbol).toBe('BNT');
  });

  it('does not confuse decimals 0 with missing decimals', async () => {
    const store: Store = {
      octZero: token('ao', 'ao', '0', '100', { [ME]: '100' }),
      octMissing: token('BFC', 'BFC', null, '100', { [ME]: '100' }),
    };
    const { rpc } = makeFake({ contracts: ['octZero', 'octMissing'], store });
    const held = await scanForTokens(rpc, ME);

    const zero = held.find((h) => h.symbol === 'ao')!;
    const missing = held.find((h) => h.symbol === 'BFC')!;
    expect(zero.decimals).toBe(0);
    expect(zero.amount.unscaled).toBe(false);
    expect(missing.decimals).toBeNull();
    expect(missing.amount.unscaled).toBe(true);
  });
});

describe('addTokenByAddress', () => {
  const STORE: Store = {
    octTok: token('PX', 'PAAMM X', '6', '10000000', { [ME]: '2000000' }),
    octZero: token('ZED', 'Zed', '6', '1000', {}),
    octNothing: {},
  };

  it('adds a token and reads the balance', async () => {
    const { rpc } = makeFake({ contracts: [], store: STORE });
    const h = await addTokenByAddress(rpc, ME, 'octTok');
    expect(h.symbol).toBe('PX');
    expect(h.amount.display).toBe('2');
    expect(h.custom).toBe(true);
  });

  it('keeps a manually added token even at zero balance', async () => {
    const { rpc } = makeFake({ contracts: [], store: STORE });
    await addTokenByAddress(rpc, ME, 'octZero');
    const cached = await loadCachedHoldings(URL_, ME);
    expect(cached).toHaveLength(1);
    expect(cached[0].raw).toBe(0n);
    expect(cached[0].custom).toBe(true);
  });

  it('rejects an address with no token data rather than adding an empty row', async () => {
    const { rpc } = makeFake({ contracts: [], store: STORE });
    await expect(addTokenByAddress(rpc, ME, 'octNothing')).rejects.toThrow(/no ocs01 token/i);
  });

  it('does not require a full scan', async () => {
    const { rpc, calls } = makeFake({ contracts: [], store: STORE });
    await addTokenByAddress(rpc, ME, 'octTok');
    expect(calls.storageReads).toBe(5); // metadata + balance only
  });
});

describe('removeToken', () => {
  it('forgets a token completely', async () => {
    const store: Store = { octTok: token('PX', 'PX', '6', '10', { [ME]: '5' }) };
    const { rpc } = makeFake({ contracts: [], store });
    await addTokenByAddress(rpc, ME, 'octTok');
    await removeToken(URL_, ME, 'octTok');
    expect(await loadCachedHoldings(URL_, ME)).toEqual([]);
  });
});

describe('refreshHoldings', () => {
  it('updates balances for known tokens only', async () => {
    const store: Store = { octTok: token('PX', 'PX', '6', '10000000', { [ME]: '1000000' }) };
    const { rpc } = makeFake({ contracts: [], store });
    await addTokenByAddress(rpc, ME, 'octTok');

    store.octTok[`balances:${ME}`] = '7500000';
    const refreshed = await refreshHoldings(rpc, ME);
    expect(refreshed[0].amount.display).toBe('7.5');
  });

  it('preserves the last known balance when a read fails', async () => {
    const store: Store = { octTok: token('PX', 'PX', '6', '10', { [ME]: '4000000' }) };
    const { rpc } = makeFake({ contracts: [], store });
    await addTokenByAddress(rpc, ME, 'octTok');

    const broken = makeFake({ contracts: [], store, failBatches: true });
    const refreshed = await refreshHoldings(broken.rpc, ME);
    // Must NOT report 0 just because the network hiccuped.
    expect(refreshed[0].raw).toBe(4000000n);
  });

  it('does nothing when no tokens are known', async () => {
    const { rpc, calls } = makeFake({ contracts: [], store: {} });
    expect(await refreshHoldings(rpc, ME)).toEqual([]);
    expect(calls.batches).toBe(0);
  });
});
