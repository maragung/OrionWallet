import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NetworkSwitcher } from '../../src/components/NetworkSwitcher';
import { useWalletStore } from '../../src/store/wallet-store';
import { loadSettings, saveSettings, wipeEverything, closeDb } from '../../src/wallet/storage';

/**
 * Regression cover for a top-bar network pill that did nothing when tapped.
 *
 * Two independent causes, one per assertion below:
 *  - the click handler bailed out whenever the store had no settings yet, which
 *    one failed read at boot was enough to cause for the life of the page;
 *  - the menu was positioned inside the header action row, which is
 *    `overflow: hidden` on phones, so it opened somewhere no pixel was painted.
 */

/** React 18 wants this flag before `act` is used. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/**
 * Wait for a condition inside `act`, so the re-renders the awaited storage work
 * triggers are attributed to the test rather than warned about.
 */
async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 200 && !predicate(); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

/** The menu renders through a portal, so it is not inside `container`. */
function menu(): HTMLElement | null {
  return document.body.querySelector('[data-testid="network-menu"]');
}

function rowFor(name: string): HTMLButtonElement {
  const rows = Array.from(menu()?.querySelectorAll('button') ?? []);
  const row = rows.find((b) => (b.textContent ?? '').includes(name.toUpperCase()));
  if (!row) throw new Error(`no menu row for ${name}; saw ${rows.length} rows`);
  return row as HTMLButtonElement;
}

async function openMenu(): Promise<void> {
  const pill = container.querySelector<HTMLButtonElement>('button.network-pill');
  if (!pill) throw new Error('network pill did not render');
  await act(async () => {
    pill.click();
  });
}

describe('NetworkSwitcher', () => {
  beforeAll(async () => {
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    await wipeEverything();
    // Exactly the state a failed settings read leaves behind.
    useWalletStore.setState({ wallet: null, isUnlocked: false, settings: null, rpcWarning: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<NetworkSwitcher />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('switches the network when the store has no settings loaded', async () => {
    await saveSettings({
      id: 'settings',
      rpcUrl: 'https://devnet.octrascan.io/rpc',
      network: 'devnet',
      theme: 'dark',
    });
    expect(useWalletStore.getState().settings).toBeNull();

    await openMenu();
    await act(async () => {
      rowFor('mainnet').click();
    });
    await waitFor(
      'the store to publish mainnet',
      () => useWalletStore.getState().settings?.network === 'mainnet',
    );

    expect((await loadSettings()).network).toBe('mainnet');
  });

  it('lays the menu out against the viewport so an overflow:hidden row cannot clip it', async () => {
    await openMenu();

    const el = menu();
    expect(el).not.toBeNull();
    // `absolute` would be clipped by `.app-header .actions { overflow: hidden }`.
    expect(el!.style.position).toBe('fixed');
    expect(el!.style.top).not.toBe('');
    expect(el!.style.left).not.toBe('');
  });

  it('survives the pointer-down that precedes a click on one of its own rows', async () => {
    // The menu is portalled out of the trigger's subtree, so a naive
    // "mousedown outside the wrapper closes it" check would unmount the row
    // between mousedown and click — and the selection would never happen.
    await saveSettings({
      id: 'settings',
      rpcUrl: 'https://devnet.octrascan.io/rpc',
      network: 'devnet',
      theme: 'dark',
    });

    await openMenu();
    const row = rowFor('mainnet');
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menu(), 'menu closed itself on its own mousedown').not.toBeNull();

    await act(async () => {
      row.click();
    });
    await waitFor(
      'the store to publish mainnet',
      () => useWalletStore.getState().settings?.network === 'mainnet',
    );
    expect((await loadSettings()).network).toBe('mainnet');
  });

  it('closes on a pointer-down outside the menu', async () => {
    await openMenu();
    expect(menu()).not.toBeNull();

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(menu()).toBeNull();
    outside.remove();
  });

  it('closes on Escape', async () => {
    await openMenu();
    expect(menu()).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(menu()).toBeNull();
  });

  it('closes the menu after a selection', async () => {
    await saveSettings({
      id: 'settings',
      rpcUrl: 'https://devnet.octrascan.io/rpc',
      network: 'devnet',
      theme: 'dark',
    });

    await openMenu();
    expect(menu()).not.toBeNull();

    await act(async () => {
      rowFor('mainnet').click();
    });
    await waitFor('the menu to close', () => menu() === null);

    expect(menu()).toBeNull();
  });
});
