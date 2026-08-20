/**
 * "Your tokens" panel wiring.
 *
 * The discovery logic itself is covered in tokens-devnet-discovery.test.ts;
 * these tests pin what the PANEL promises:
 *   - it finds tokens by itself, with nobody pressing a button;
 *   - it says which network the list belongs to, and never carries a devnet
 *     balance over to mainnet;
 *   - loading, empty and error each look different from one another.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TokensView } from '../../src/components/TokensView';
import { useWalletStore } from '../../src/store/wallet-store';
import { RpcClient } from '../../src/rpc/client';
import { wipeEverything, closeDb, type Settings } from '../../src/wallet/storage';
import type { Wallet } from '../../src/wallet/wallet';

/** React 18 wants this flag before `act` is used. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEVNET_URL = 'https://devnet.octrascan.io/rpc';
const MAINNET_URL = 'https://octra.network/rpc';
const ME = 'oct2mhQQYM3MmDwMxbcpvTCMgSVPxh47YUdZGn3aR1r13PK';
const WOCT_EXAMPLE = 'oct22PbjipMh9tvvLobfxXBdqNaAwefMrmwCq1rRivnFUxV';
const DOGS_EXAMPLE = 'oct3Ubvf98ZGUaZ26N86e3yG4nfP9CTCvzG3wTCr9mXtuzP';
const MAINNET_TOKEN = 'oct7MainnetOnlyTokenFixtureBBBBBBBBBBBBBBBBBBBBB';

type Store = Record<string, Record<string, string | null>>;

/**
 * A small node: two tokens the address holds, plus filler contracts so the
 * sweep is a real sweep. Kept far below the batch limit — the panel is what is
 * under test here, not the chunking.
 */
function node(opts: { url: string; store: Store; failList?: boolean; delayMs?: number }) {
  const contracts = [
    ...Object.keys(opts.store),
    ...Array.from({ length: 6 }, (_, i) => `octFiller${i}`),
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const handle = (req: { method: string; params: unknown[]; id: number }) => {
      if (req.method === 'octra_listContracts') {
        if (opts.failList) {
          return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'node offline' } };
        }
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { contracts: contracts.map((a) => ({ address: a, owner: 'octSomeoneElse' })) },
        };
      }
      if (req.method === 'octra_contractStorage') {
        const [addr, key] = req.params as [string, string];
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { key, value: opts.store[addr]?.[key] ?? null },
        };
      }
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
    };
    const out = Array.isArray(body) ? body.map(handle) : handle(body);
    if (opts.delayMs !== undefined && Array.isArray(body)) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return new RpcClient({ url: opts.url, fetchImpl });
}

function tokenRecord(sym: string, name: string, bal: string): Record<string, string | null> {
  return {
    symbol: sym,
    name,
    decimals: '6',
    total_supply: '1000000000000',
    [`balances:${ME}`]: bal,
  };
}

const DEVNET_STORE: Store = {
  [WOCT_EXAMPLE]: tokenRecord('WOCT', 'Wrapped OCT', '2000000'),
  [DOGS_EXAMPLE]: tokenRecord('DOGS', 'DOGS', '1000000000000'),
};
const MAINNET_STORE: Store = {
  [MAINNET_TOKEN]: tokenRecord('PX', 'Pixel', '777000'),
};

const WALLET: Wallet = {
  addr: ME,
  sk: new Uint8Array(64),
  pk: new Uint8Array(32),
  pubB64: '',
  privB64: '',
  mnemonic: '',
  hdMaster: new Uint8Array(0),
  name: 'Account 1',
  index: 0,
  hdVersion: 2,
  createdAt: 0,
};

function settingsFor(network: 'devnet' | 'mainnet'): Settings {
  return {
    id: 'settings',
    rpcUrl: network === 'devnet' ? DEVNET_URL : MAINNET_URL,
    network,
    theme: 'dark',
  };
}

let container: HTMLDivElement;
let root: Root;

/**
 * Poll until the DOM satisfies `predicate`.
 *
 * One `act` call per poll, deliberately: React commits the queued updates when
 * an act scope EXITS, so a loop that awaits inside a single scope would never
 * see the DOM change and would always run to its limit.
 */
async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !predicate(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

function text(): string {
  return container.textContent ?? '';
}

/** Contract addresses the panel is currently showing, in row order. */
function rowAddresses(): string[] {
  return Array.from(container.querySelectorAll('.token-card .token-addr .mono')).map(
    (el) => el.getAttribute('title') ?? '',
  );
}

function hasRow(contract: string): boolean {
  return rowAddresses().includes(contract);
}

/** The balance cell of one contract's row. */
function balanceOf(contract: string): string {
  const card = Array.from(container.querySelectorAll('.token-card')).find(
    (el) => el.querySelector(`.token-addr .mono[title="${contract}"]`) !== null,
  );
  if (!card) throw new Error(`no row for ${contract}`);
  return card.querySelector('.token-balance')?.textContent?.trim() ?? '';
}

async function mount(network: 'devnet' | 'mainnet', rpc: RpcClient): Promise<void> {
  useWalletStore.setState({
    wallet: WALLET,
    isUnlocked: true,
    rpc,
    settings: settingsFor(network),
  });
  await act(async () => {
    root = createRoot(container);
    root.render(<TokensView />);
  });
}

describe('TokensView', () => {
  beforeAll(async () => {
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    await wipeEverything();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useWalletStore.setState({ wallet: null, isUnlocked: false, rpc: null, settings: null });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("discovers the address's tokens on mount, with no button pressed", async () => {
    await mount('devnet', node({ url: DEVNET_URL, store: DEVNET_STORE }));

    await waitFor(
      'both example tokens to appear',
      () => hasRow(WOCT_EXAMPLE) && hasRow(DOGS_EXAMPLE),
    );

    expect(text()).toContain('WOCT');
    expect(text()).toContain('DOGS');
    // Balances are scaled by the contract's own decimals.
    expect(text()).toContain('1,000,000');
    // And the list says which network it belongs to.
    expect(text()).toContain('Devnet');
  });

  it('says it is still looking rather than claiming the address holds nothing', async () => {
    // Slow the node so the mid-sweep state lasts long enough to observe; on a
    // real network a sweep takes tens of seconds.
    await mount('devnet', node({ url: DEVNET_URL, store: DEVNET_STORE, delayMs: 60 }));

    // Until the cached list has been read, the panel shows placeholders — an
    // empty state here would claim the address holds nothing.
    expect(container.querySelector('.skeleton')).not.toBeNull();
    expect(text()).not.toContain('No tokens yet');

    await waitFor('the searching state', () => text().includes('Looking for your tokens'));
    expect(text()).not.toContain('No tokens yet');
    // The sweep reports how far it has got.
    expect(container.querySelector('.progress-fill')).not.toBeNull();

    await waitFor('the sweep to finish', () => hasRow(DOGS_EXAMPLE));
    expect(text()).not.toContain('Looking for your tokens');
  });

  it('reports an address that genuinely holds nothing', async () => {
    await mount('devnet', node({ url: DEVNET_URL, store: {} }));

    await waitFor('the empty state', () => text().includes('No tokens yet'));
    expect(text()).toContain('Devnet');
    expect(rowAddresses()).toHaveLength(0);
  });

  it('shows why the list is empty when the node cannot be reached', async () => {
    await mount('devnet', node({ url: DEVNET_URL, store: DEVNET_STORE, failList: true }));

    await waitFor('the error box', () => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'listContracts failed',
    );
  });

  it('replaces the list when the network changes, never merging the two', async () => {
    const devnet = node({ url: DEVNET_URL, store: DEVNET_STORE });
    await mount('devnet', devnet);
    await waitFor('devnet tokens', () => hasRow(WOCT_EXAMPLE) && hasRow(DOGS_EXAMPLE));

    // Exactly what the store does on a network switch: a brand new RpcClient.
    await act(async () => {
      useWalletStore.setState({
        rpc: node({ url: MAINNET_URL, store: MAINNET_STORE }),
        settings: settingsFor('mainnet'),
      });
    });

    await waitFor('the mainnet token', () => hasRow(MAINNET_TOKEN));
    expect(hasRow(WOCT_EXAMPLE)).toBe(false);
    expect(hasRow(DOGS_EXAMPLE)).toBe(false);
    expect(text()).toContain('Mainnet');
    expect(text()).toContain('PX');
  });

  it('re-reads balances when the panel is opened again', async () => {
    const store: Store = {
      [WOCT_EXAMPLE]: tokenRecord('WOCT', 'Wrapped OCT', '2000000'),
      [DOGS_EXAMPLE]: tokenRecord('DOGS', 'DOGS', '1000000000000'),
    };
    const rpc = node({ url: DEVNET_URL, store });
    await mount('devnet', rpc);
    await waitFor('the first read', () => hasRow(DOGS_EXAMPLE));

    // A transfer settles while the panel is closed.
    store[DOGS_EXAMPLE][`balances:${ME}`] = '5000000';
    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<TokensView />);
    });

    await waitFor(
      'the refreshed balance',
      () => hasRow(DOGS_EXAMPLE) && balanceOf(DOGS_EXAMPLE) === '5',
    );
    // The other row is still there, from cache, at its own balance.
    expect(balanceOf(WOCT_EXAMPLE)).toBe('2');
  });
});
