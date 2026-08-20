/**
 * "Your tokens" on Devnet — discovery against a fake node built from real data.
 *
 * The fixture below is a SNAPSHOT of live devnet, captured by probing
 * `balances:<address>` on all 6785 deployed contracts for
 * `oct2mhQQYM3MmDwMxbcpvTCMgSVPxh47YUdZGn3aR1r13PK`. That address holds 13
 * tokens, nine of which it deployed and four of which it merely received, plus
 * one token it deployed and holds none of. The two tokens named in the bug
 * report — `oct22Pbji…` (WOCT) and `oct3Ubvf…` (DOGS) — are among them.
 *
 * The snapshot is replayed offline: the tests must not touch the network, and a
 * chain's state moves. What they pin is the LOGIC that turned an address into
 * that list — probe every contract, never trust a static list, keep networks and
 * accounts apart, and be honest when a read was lost.
 *
 * The contract universe is scaled down from 6785 to 150 so a sweep spans several
 * batches (which is what exercises chunking, pacing and retries) without the
 * suite spending a minute in `setTimeout`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RpcClient } from '../../src/rpc/client';
import {
  discoverTokens,
  isDiscoveryDue,
  loadCachedHoldings,
  refreshHoldings,
  DISCOVERY_TTL_MS,
  type ScanProgress,
  type TokenHolding,
} from '../../src/api/tokens';
import { saveTokenRegistry, wipeEverything } from '../../src/wallet/storage';

const DEVNET_URL = 'https://devnet.octrascan.io/rpc';
const MAINNET_URL = 'https://octra.network/rpc';

/** The address from the report. */
const ME = 'oct2mhQQYM3MmDwMxbcpvTCMgSVPxh47YUdZGn3aR1r13PK';
/** Deployer of the tokens this address received rather than created. */
const OTHER = 'octCo5bJiSwt96Lm7PWM1yzcALsApEWrudoFykSaAGk3Mpy';

/** The two contracts the report names. */
const WOCT_EXAMPLE = 'oct22PbjipMh9tvvLobfxXBdqNaAwefMrmwCq1rRivnFUxV';
const DOGS_EXAMPLE = 'oct3Ubvf98ZGUaZ26N86e3yG4nfP9CTCvzG3wTCr9mXtuzP';
/** Deployed by this address, balance zero — must still be listed. */
const DEPLOYED_ZERO = 'octCh7oVW2d987Kf5CGzhVVFdK4i1fe7cgT2FiV9TbJqJds';
/** Received, not deployed: only a balance probe can find these four. */
const RECEIVED = [
  'oct4pAKouypxmP7Uk79uGzEpkkidsNAK3fQhxy1HDUmBRLE',
  'oct9GJXWUyQZvYm65dtzHC9m9xgQP1qMZjPgKJ7by58qXUg',
  'oct99SN8iHKN7JSVCYALQPmhCzjA1hbXMtjD2ekFAspH5BB',
  'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD',
];
const ALEXO_RECEIVED = 'oct9GJXWUyQZvYm65dtzHC9m9xgQP1qMZjPgKJ7by58qXUg';
/** A holding whose contract publishes no metadata at all. */
const BARE = 'oct6BareTokenWithNoMetadataAtAllFixtureAAAAAAAAA';
/** Devnet-only marker: proves a mainnet list cannot borrow devnet's answers. */
const MAINNET_ONLY = 'oct7MainnetOnlyTokenFixtureBBBBBBBBBBBBBBBBBBBBB';

/** Live devnet reading for ME, as captured. `bal: '0'` means "no entry". */
const DEVNET_TOKENS = [
  {
    c: 'oct4g33tzC2cJncL5RFr9TRiyk8yCNP1h2xaogiWJS5opNv',
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '2504384370',
    bal: '2500506118',
    mine: true,
  },
  {
    c: WOCT_EXAMPLE,
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '2000000',
    bal: '2000000',
    mine: true,
  },
  {
    c: DOGS_EXAMPLE,
    sym: 'DOGS',
    name: 'DOGS',
    dec: '6',
    supply: '1000000000000',
    bal: '1000000000000',
    mine: true,
  },
  {
    c: 'octGURUy7hQhXHVcP9bovbJnpoXqCv2gpWBrk6fqtXqJ2sC',
    sym: 'OES',
    name: 'Octra Everest Swap',
    dec: '6',
    supply: '666000000000000',
    bal: '666000000000000',
    mine: true,
  },
  {
    c: 'octE7uuPRADiRGSp1ESUeZsaChDqCUKNvQfrtmZAQbA6NZU',
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '2000000',
    bal: '2000000',
    mine: true,
  },
  {
    c: 'octDoNEKGPzgD1SHb7yne8e2LuzapX6SErYb6TqrYqLcD1U',
    sym: 'DOGS',
    name: 'DOGS',
    dec: '6',
    supply: '1000000000000',
    bal: '1000000000000',
    mine: true,
  },
  {
    c: 'oct4pAKouypxmP7Uk79uGzEpkkidsNAK3fQhxy1HDUmBRLE',
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '12190838',
    bal: '1427200',
    mine: false,
  },
  {
    c: 'octAzhPgstBrTDZGGH3KnWic8VrRn3QG3BpxuAKmd5Cdnws',
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '2000000',
    bal: '2000000',
    mine: true,
  },
  {
    c: ALEXO_RECEIVED,
    sym: 'ALEXO',
    name: 'ALEX',
    dec: '6',
    supply: '1000000000000000',
    bal: '532014258042171',
    mine: false,
  },
  {
    c: 'oct99SN8iHKN7JSVCYALQPmhCzjA1hbXMtjD2ekFAspH5BB',
    sym: 'ALEXO',
    name: 'ALEX',
    dec: '6',
    supply: '1000000000000000',
    bal: '767798263131007',
    mine: false,
  },
  {
    c: 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD',
    sym: 'OES',
    name: 'Octra Everest Swap',
    dec: '6',
    supply: '666000000000000',
    bal: '1226481752',
    mine: false,
  },
  {
    c: 'octHjgwnqTm7CP36biGnDaNN9t9MpXv3bYAf1nmnnuV4Qk4',
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '2000000',
    bal: '500000',
    mine: true,
  },
  {
    c: 'oct8TS16Xt9CkFxgFjoc2AhfwJ5Z9JxUSDTi5ATjWFd6V16',
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '2000000',
    bal: '2000000',
    mine: true,
  },
  {
    c: DEPLOYED_ZERO,
    sym: 'WOCT',
    name: 'Wrapped OCT',
    dec: '6',
    supply: '0',
    bal: '0',
    mine: true,
  },
] as const;

/** Contracts with balances, by definition of the fixture. */
const HELD_COUNT = DEVNET_TOKENS.filter((t) => t.bal !== '0').length + 1; // + BARE
/** Rows the panel should show: every holding, plus the deployed empty one. */
const EXPECTED_ROWS = HELD_COUNT + 1;

/**
 * Contracts deployed by ME that are not tokens at all — devnet has 38 of them.
 * Eight is enough to prove the deployer fast path filters rather than trusts.
 */
const NON_TOKEN_DEPLOYED = Array.from({ length: 8 }, (_, i) => `octNotAToken${i}`);

const UNIVERSE_SIZE = 150;

/** Storage fixture: contract -> key -> value (mirrors the node's flat KV). */
type Store = Record<string, Record<string, string | null>>;
interface Contract {
  address: string;
  owner: string;
}

/**
 * Lay the interesting contracts across the whole universe.
 *
 * 53 is coprime with 150, so `i * 53 + 7` visits a distinct slot every time.
 * The point is that the fixture's tokens land in DIFFERENT batches — including
 * the two named ones — so a test that throttles or fails one batch cannot
 * accidentally take out the whole answer.
 */
function place(i: number): number {
  return (i * 53 + 7) % UNIVERSE_SIZE;
}

function buildDevnet(): { universe: Contract[]; store: Store } {
  const slots: Array<Contract | null> = Array.from({ length: UNIVERSE_SIZE }, () => null);
  const store: Store = {};
  let slot = 0;

  for (const tok of DEVNET_TOKENS) {
    slots[place(slot++)] = { address: tok.c, owner: tok.mine ? ME : OTHER };
    const rec: Record<string, string | null> = {
      symbol: tok.sym,
      name: tok.name,
      decimals: tok.dec,
      total_supply: tok.supply,
    };
    // A zero holding is an ABSENT key on the real node, not a stored "0".
    if (tok.bal !== '0') rec[`balances:${ME}`] = tok.bal;
    store[tok.c] = rec;
  }

  // Held, but the contract answers nothing about itself.
  slots[place(slot++)] = { address: BARE, owner: OTHER };
  store[BARE] = { [`balances:${ME}`]: '4200' };

  // Deployed by ME, not a token: phase 1 must skip these, not list them.
  for (const addr of NON_TOKEN_DEPLOYED) {
    slots[place(slot++)] = { address: addr, owner: ME };
    store[addr] = {};
  }

  const universe = slots.map(
    (c, i) => c ?? { address: `octFiller${i}`, owner: `octDeployer${i % 7}` },
  );
  return { universe, store };
}

interface NodeOpts {
  url: string;
  universe: Contract[];
  store: Store;
  /** Reply out of order, as JSON-RPC permits. */
  shuffle?: boolean;
  /** HTTP 429 the FIRST batch that reads this contract, then behave. */
  throttleOnceFor?: string;
  /** HTTP 502 every batch that reads this contract. */
  failFor?: string;
  /** Omit the deployer from `octra_listContracts`, as an older node would. */
  hideOwners?: boolean;
}

function makeNode(opts: NodeOpts) {
  const calls = { listContracts: 0, batches: 0, storageReads: 0, throttled: 0, failed: 0 };
  let throttleArmed = opts.throttleOnceFor !== undefined;

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));

    const handle = (req: { method: string; params: unknown[]; id: number }) => {
      if (req.method === 'octra_listContracts') {
        calls.listContracts++;
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            contracts: opts.universe.map((c) => ({
              address: c.address,
              ...(opts.hideOwners ? {} : { owner: c.owner }),
              code_hash: 'h',
            })),
          },
        };
      }
      if (req.method === 'octra_contractStorage') {
        calls.storageReads++;
        const [addr, key] = req.params as [string, string];
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { key, value: opts.store[addr]?.[key] ?? null },
        };
      }
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
    };

    if (Array.isArray(body)) {
      calls.batches++;
      const reads = (target: string): boolean =>
        body.some((r) => Array.isArray(r.params) && r.params[0] === target);

      // A throttled or failed batch loses EVERY call in it — that is exactly
      // how rate limiting turns into missing tokens.
      if (opts.failFor !== undefined && reads(opts.failFor)) {
        calls.failed++;
        return new Response('bad gateway', { status: 502 });
      }
      if (throttleArmed && opts.throttleOnceFor !== undefined && reads(opts.throttleOnceFor)) {
        throttleArmed = false;
        calls.throttled++;
        return new Response('slow down', { status: 429 });
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
      if (opts.shuffle) out = [...out].reverse();
      return new Response(JSON.stringify(out), { status: 200 });
    }

    return new Response(JSON.stringify(handle(body)), { status: 200 });
  }) as unknown as typeof fetch;

  return { rpc: new RpcClient({ url: opts.url, fetchImpl }), calls };
}

/** Devnet node carrying the captured state. */
function devnetNode(extra: Partial<NodeOpts> = {}) {
  const { universe, store } = buildDevnet();
  return makeNode({ url: DEVNET_URL, universe, store, ...extra });
}

/** Mainnet node holding one token nobody on devnet has ever seen. */
function mainnetNode() {
  const universe: Contract[] = [{ address: MAINNET_ONLY, owner: OTHER }];
  const store: Store = {
    [MAINNET_ONLY]: {
      symbol: 'PX',
      name: 'Pixel',
      decimals: '6',
      total_supply: '1000000',
      [`balances:${ME}`]: '777000',
    },
  };
  return makeNode({ url: MAINNET_URL, universe, store });
}

function byContract(holdings: TokenHolding[]): Map<string, TokenHolding> {
  return new Map(holdings.map((h) => [h.contract, h]));
}

/** Move the wallet's clock forward without touching `setTimeout` pacing. */
function advanceClock(ms: number): void {
  const at = Date.now() + ms;
  vi.spyOn(Date, 'now').mockImplementation(() => at);
}

beforeEach(async () => {
  await wipeEverything();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Devnet discovery for the reported address', () => {
  it('detects both tokens named in the report, with metadata and scaled balances', async () => {
    const { rpc } = devnetNode();

    const { holdings } = await discoverTokens(rpc, ME);
    const found = byContract(holdings);

    const woct = found.get(WOCT_EXAMPLE);
    expect(woct).toBeDefined();
    expect(woct!.symbol).toBe('WOCT');
    expect(woct!.name).toBe('Wrapped OCT');
    expect(woct!.decimals).toBe(6);
    expect(woct!.raw).toBe(2_000_000n);
    expect(woct!.amount.display).toBe('2');
    expect(woct!.amount.unscaled).toBe(false);

    const dogs = found.get(DOGS_EXAMPLE);
    expect(dogs).toBeDefined();
    expect(dogs!.symbol).toBe('DOGS');
    expect(dogs!.name).toBe('DOGS');
    expect(dogs!.decimals).toBe(6);
    expect(dogs!.raw).toBe(1_000_000_000_000n);
    expect(dogs!.amount.display).toBe('1,000,000');
  });

  it('lists every holding, received ones included, and reports the sweep complete', async () => {
    const { rpc } = devnetNode();

    const result = await discoverTokens(rpc, ME);

    expect(result.holdings).toHaveLength(EXPECTED_ROWS);
    expect(result.unreadable).toBe(0);
    expect(result.contractCount).toBe(UNIVERSE_SIZE);
    // Received tokens are invisible in transaction history — finding these is
    // the whole reason the sweep exists.
    const found = byContract(result.holdings);
    for (const addr of RECEIVED) expect(found.get(addr)?.raw).toBeGreaterThan(0n);
    expect(found.get(ALEXO_RECEIVED)!.raw).toBe(532_014_258_042_171n);
    expect(found.get(ALEXO_RECEIVED)!.deployed).toBe(false);
  });

  it('finds the same tokens with no deployer information at all', async () => {
    // An older node omits `owner`, so the fast path is unavailable and every
    // contract has to be probed. The answer must not change.
    const { rpc, calls } = devnetNode({ hideOwners: true });

    const { holdings } = await discoverTokens(rpc, ME);
    const found = byContract(holdings);

    expect(found.has(WOCT_EXAMPLE)).toBe(true);
    expect(found.has(DOGS_EXAMPLE)).toBe(true);
    expect(holdings).toHaveLength(HELD_COUNT); // the zero-balance one needs the fast path
    expect(calls.storageReads).toBeGreaterThan(UNIVERSE_SIZE);
  });

  it('keeps a token this address deployed but holds none of', async () => {
    const { rpc } = devnetNode();

    const { holdings } = await discoverTokens(rpc, ME);
    const zero = byContract(holdings).get(DEPLOYED_ZERO);

    expect(zero).toBeDefined();
    expect(zero!.raw).toBe(0n);
    expect(zero!.deployed).toBe(true);
    expect(zero!.symbol).toBe('WOCT');
  });

  it('shows a holding whose contract publishes no metadata', async () => {
    const { rpc } = devnetNode();

    const { holdings } = await discoverTokens(rpc, ME);
    const bare = byContract(holdings).get(BARE);

    expect(bare).toBeDefined();
    expect(bare!.symbol).toBeNull();
    expect(bare!.name).toBeNull();
    expect(bare!.decimals).toBeNull();
    expect(bare!.raw).toBe(4200n);
    // Unknown scale: the raw figure is shown, flagged, rather than guessed at.
    expect(bare!.amount.unscaled).toBe(true);
    expect(bare!.amount.display).toBe('4,200');
  });

  it('ignores contracts this address deployed that are not tokens', async () => {
    const { rpc } = devnetNode();

    const { holdings } = await discoverTokens(rpc, ME);

    for (const addr of NON_TOKEN_DEPLOYED) {
      expect(holdings.some((h) => h.contract === addr)).toBe(false);
    }
  });

  it('streams each token as it is found and reports progress to the end', async () => {
    const { rpc } = devnetNode();
    const hits: string[] = [];
    const seen: ScanProgress[] = [];

    const { holdings } = await discoverTokens(rpc, ME, {
      onHit: (h) => hits.push(h.contract),
      onProgress: (p) => seen.push({ ...p }),
    });

    expect(hits).toHaveLength(holdings.length);
    expect(hits).toContain(WOCT_EXAMPLE);
    expect(hits).toContain(DOGS_EXAMPLE);
    const last = seen[seen.length - 1];
    expect(last.total).toBe(UNIVERSE_SIZE);
    expect(last.scanned).toBe(UNIVERSE_SIZE);
    expect(last.found).toBe(holdings.length);
  });

  it('survives out-of-order batch replies', async () => {
    const { rpc } = devnetNode({ shuffle: true });

    const { holdings } = await discoverTokens(rpc, ME);
    const found = byContract(holdings);

    expect(found.get(WOCT_EXAMPLE)!.raw).toBe(2_000_000n);
    expect(found.get(DOGS_EXAMPLE)!.raw).toBe(1_000_000_000_000n);
    expect(holdings).toHaveLength(EXPECTED_ROWS);
  });
});

describe('Network and account isolation', () => {
  it('never lets a devnet token appear under mainnet', async () => {
    const devnet = devnetNode();
    const mainnet = mainnetNode();

    await discoverTokens(devnet.rpc, ME);
    const onMainnet = await discoverTokens(mainnet.rpc, ME);

    // Mainnet sees only its own token…
    expect(onMainnet.holdings.map((h) => h.contract)).toEqual([MAINNET_ONLY]);
    // …and the devnet list is untouched by the mainnet sweep.
    const devnetCached = await loadCachedHoldings(DEVNET_URL, ME);
    expect(devnetCached).toHaveLength(EXPECTED_ROWS);
    expect(devnetCached.some((h) => h.contract === MAINNET_ONLY)).toBe(false);
    expect(await loadCachedHoldings(MAINNET_URL, ME)).toHaveLength(1);
  });

  it('keeps each network on its own discovery schedule', async () => {
    const devnet = devnetNode();
    await discoverTokens(devnet.rpc, ME);

    expect(await isDiscoveryDue(DEVNET_URL, ME)).toBe(false);
    // Switching network must trigger a sweep, not inherit devnet's freshness.
    expect(await isDiscoveryDue(MAINNET_URL, ME)).toBe(true);
  });

  it("keeps one account out of another account's list", async () => {
    const { rpc } = devnetNode();

    await discoverTokens(rpc, ME);
    await discoverTokens(rpc, OTHER);

    const mine = byContract(await loadCachedHoldings(DEVNET_URL, ME));
    const theirs = byContract(await loadCachedHoldings(DEVNET_URL, OTHER));

    expect(mine.get(ALEXO_RECEIVED)!.raw).toBe(532_014_258_042_171n);
    // OTHER deployed that contract but holds nothing in it.
    expect(theirs.get(ALEXO_RECEIVED)!.raw).toBe(0n);
    // Tokens ME deployed are not in OTHER's list at all.
    expect(theirs.has(WOCT_EXAMPLE)).toBe(false);
    expect(theirs.has(DOGS_EXAMPLE)).toBe(false);
  });
});

describe('Caching and refresh', () => {
  it('suppresses a second sweep inside the TTL and asks for one after it', async () => {
    const { rpc } = devnetNode();

    await discoverTokens(rpc, ME);
    expect(await isDiscoveryDue(DEVNET_URL, ME)).toBe(false);

    advanceClock(DISCOVERY_TTL_MS + 1_000);
    expect(await isDiscoveryDue(DEVNET_URL, ME)).toBe(true);
  });

  it('reuses the cached contract list on the next sweep', async () => {
    const { rpc, calls } = devnetNode();

    await discoverTokens(rpc, ME);
    await discoverTokens(rpc, ME, { force: false });

    expect(calls.listContracts).toBe(1);
  });

  it('re-reads balances of known tokens without another sweep', async () => {
    const { universe, store } = buildDevnet();
    const { rpc, calls } = makeNode({ url: DEVNET_URL, universe, store });

    await discoverTokens(rpc, ME);
    const sweepReads = calls.storageReads;

    // A transfer lands: the balance changes on chain.
    store[DOGS_EXAMPLE][`balances:${ME}`] = '999';
    const refreshed = byContract(await refreshHoldings(rpc, ME));

    expect(refreshed.get(DOGS_EXAMPLE)!.raw).toBe(999n);
    // Cheap: a refresh reads the known contracts, not the whole universe.
    expect(calls.storageReads - sweepReads).toBeLessThan(UNIVERSE_SIZE);
    // And it must not forget which tokens this address deployed.
    expect(refreshed.get(DEPLOYED_ZERO)!.deployed).toBe(true);
  });

  it('serves the cached list before any request is made', async () => {
    const { rpc } = devnetNode();
    await discoverTokens(rpc, ME);

    // What the panel paints on mount, with no node involved at all.
    const cached = byContract(await loadCachedHoldings(DEVNET_URL, ME));
    expect(cached.get(WOCT_EXAMPLE)!.raw).toBe(2_000_000n);
    expect(cached.get(DOGS_EXAMPLE)!.raw).toBe(1_000_000_000_000n);
  });
});

describe('Lost reads', () => {
  it('retries a throttled batch instead of losing its tokens', async () => {
    const { rpc, calls } = devnetNode({ throttleOnceFor: ALEXO_RECEIVED });

    const result = await discoverTokens(rpc, ME);

    expect(calls.throttled).toBe(1);
    // The retry recovered every probe in that batch.
    expect(byContract(result.holdings).get(ALEXO_RECEIVED)!.raw).toBe(532_014_258_042_171n);
    expect(result.unreadable).toBe(0);
    expect(result.holdings).toHaveLength(EXPECTED_ROWS);
    expect(await isDiscoveryDue(DEVNET_URL, ME)).toBe(false);
  });

  it('reports an incomplete sweep and asks to run again', async () => {
    const { rpc } = devnetNode({ failFor: ALEXO_RECEIVED });

    const result = await discoverTokens(rpc, ME);

    // One batch of probes was lost; those contracts are unknown, not empty.
    expect(result.unreadable).toBeGreaterThan(0);
    expect(byContract(result.holdings).has(ALEXO_RECEIVED)).toBe(false);
    // A partial answer must never be recorded as a completed sweep.
    expect(await isDiscoveryDue(DEVNET_URL, ME)).toBe(true);
    // Everything outside the lost batch still arrived, both named tokens included.
    const found = byContract(result.holdings);
    expect(found.get(WOCT_EXAMPLE)!.raw).toBe(2_000_000n);
    expect(found.get(DOGS_EXAMPLE)!.raw).toBe(1_000_000_000_000n);
  });

  it('finds the missing token once the endpoint recovers', async () => {
    const { universe, store } = buildDevnet();
    const failing = makeNode({ url: DEVNET_URL, universe, store, failFor: ALEXO_RECEIVED });
    await discoverTokens(failing.rpc, ME);

    const healthy = makeNode({ url: DEVNET_URL, universe, store });
    const second = await discoverTokens(healthy.rpc, ME);

    expect(second.unreadable).toBe(0);
    expect(byContract(second.holdings).get(ALEXO_RECEIVED)!.raw).toBe(532_014_258_042_171n);
    expect(second.holdings).toHaveLength(EXPECTED_ROWS);
    expect(await isDiscoveryDue(DEVNET_URL, ME)).toBe(false);
  });

  it('does not overwrite a known balance when its read fails', async () => {
    const { universe, store } = buildDevnet();
    const healthy = makeNode({ url: DEVNET_URL, universe, store });
    await discoverTokens(healthy.rpc, ME);

    // The contract that answered before now sits behind a failing batch.
    const failing = makeNode({ url: DEVNET_URL, universe, store, failFor: DOGS_EXAMPLE });
    await discoverTokens(failing.rpc, ME);

    const after = byContract(await loadCachedHoldings(DEVNET_URL, ME));
    // A failed read is not a zero balance.
    expect(after.get(DOGS_EXAMPLE)!.raw).toBe(1_000_000_000_000n);
  });

  it('does not treat a stale cached contract list as the truth about balances', async () => {
    // A list cached before the two named tokens were deployed.
    await saveTokenRegistry({
      id: DEVNET_URL,
      addresses: [MAINNET_ONLY],
      owners: [OTHER],
      fetchedAt: Date.now(),
    });
    const { rpc } = devnetNode();

    // A forced sweep refetches the list rather than trusting what it had.
    const { holdings } = await discoverTokens(rpc, ME, { force: true });
    const found = byContract(holdings);

    expect(found.has(WOCT_EXAMPLE)).toBe(true);
    expect(found.has(DOGS_EXAMPLE)).toBe(true);
  });
});
