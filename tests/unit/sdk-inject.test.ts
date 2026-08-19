import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { injectWalletProvider } from '../../src/sdk/inject';
import { WalletProvider } from '../../src/sdk/WalletProvider';

/**
 * Regression: this module used to augment `Window` with `declare global`, which
 * made TypeScript refuse to compile any dApp that also types `window.octra` for
 * the browser extension's provider (TS2717). Importing the SDK barrel was
 * enough to trigger it, so builds broke in apps that never called
 * `injectWalletProvider` at all.
 */

// `import.meta.url` is an http URL under jsdom, so resolve from the repo root
// instead — vitest runs with it as cwd.
const SOURCE = readFileSync(resolve(process.cwd(), 'src/sdk/inject.ts'), 'utf8');

/**
 * The source with comments removed. The file's own docstring explains why the
 * `declare global` block was deleted, so a naive search finds it in the prose
 * and the test can never fail for the reason it exists.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** A window stand-in, so each case starts without the non-configurable props. */
function fakeWindow(): Record<string, unknown> & { dispatchEvent: ReturnType<typeof vi.fn> } {
  return { dispatchEvent: vi.fn(() => true) } as never;
}

const OPTIONS = { walletUrl: 'https://wallet.example/connect' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('src/sdk/inject.ts source', () => {
  it('does not augment the global Window type', () => {
    // Two libraries cannot both declare `window.octra`; a dApp has to make that
    // call itself, once, with a type covering every provider it supports.
    expect(CODE).not.toMatch(/declare\s+global/);
    expect(CODE).not.toMatch(/interface\s+Window\b/);
    // The explanation must stay, though: without it the block comes back.
    expect(SOURCE).toMatch(/declare global/);
  });
});

describe('injectWalletProvider', () => {
  it('attaches the provider to window.wallet and window.octra', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);

    const provider = injectWalletProvider(OPTIONS);

    expect(provider).toBeInstanceOf(WalletProvider);
    expect(win.wallet).toBe(provider);
    expect(win.octra).toBe(provider);
  });

  it('announces itself so dApps can detect it without polling', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);

    const provider = injectWalletProvider(OPTIONS);

    expect(win.dispatchEvent).toHaveBeenCalledTimes(1);
    const event = win.dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe('octra:wallet#initialized');
    expect((event.detail as { provider: WalletProvider }).provider).toBe(provider);
  });

  it('skips the announcement when announce is false', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);

    injectWalletProvider({ ...OPTIONS, announce: false });

    expect(win.dispatchEvent).not.toHaveBeenCalled();
  });

  it('leaves window.octra alone when alsoAsOctra is false', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);

    const provider = injectWalletProvider({ ...OPTIONS, alsoAsOctra: false });

    expect(win.wallet).toBe(provider);
    expect('octra' in win).toBe(false);
  });

  it('does not clobber an extension that already owns window.octra', () => {
    const win = fakeWindow();
    const extension = { isOctra: true };
    Object.defineProperty(win, 'octra', { value: extension, configurable: false });
    vi.stubGlobal('window', win);

    // The redefine throws and is swallowed: an already-connected extension
    // provider must survive a wallet that loads after it.
    const provider = injectWalletProvider(OPTIONS);

    expect(win.wallet).toBe(provider);
    expect(win.octra).toBe(extension);
  });

  it('returns the first provider on a second call rather than replacing it', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);

    const first = injectWalletProvider(OPTIONS);
    const second = injectWalletProvider(OPTIONS);

    // window.wallet is non-writable, so replacing it would throw — and a
    // second provider would orphan any session the first one holds.
    expect(second).toBe(first);
    expect(win.dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
