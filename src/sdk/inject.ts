/**
 * Attaches a WalletProvider instance to `window.wallet` and announces it,
 * MetaMask-style, so dApps can detect it without polling.
 *
 * Deliberately NO `declare global` block. Augmenting `Window` from a library is
 * a land grab: `window.octra` is already typed by the Octra browser extension's
 * own provider (RFC-O-1), and TypeScript refuses to merge two `Window`
 * declarations that give one property different types. The result was TS2717 in
 * any dApp that supports both wallets — triggered by *importing* this module,
 * which the package entry point does, so it broke builds that never call
 * `injectWalletProvider` at all.
 *
 * The properties are written through a local cast instead. A dApp that wants
 * them typed declares that once, itself, with a type covering every provider it
 * supports — which is the only place that decision can be made correctly.
 */
import { WalletProvider, type WalletProviderOptions } from './WalletProvider';

/** The globals this module writes, as this module sees them. */
interface WalletGlobals {
  wallet?: WalletProvider;
  /** Shared with the browser extension, so intentionally not narrowed here. */
  octra?: unknown;
}

export interface InjectOptions extends WalletProviderOptions {
  /** Also expose as `window.octra`. Default true. */
  alsoAsOctra?: boolean;
  /** Dispatch an `octra:wallet#initialized` event after attaching. Default true. */
  announce?: boolean;
}

/**
 * Create a provider and expose it globally. Safe to call multiple times: the
 * first provider wins to avoid clobbering an already-connected instance.
 */
export function injectWalletProvider(options: InjectOptions): WalletProvider {
  const globals = typeof window !== 'undefined' ? (window as unknown as WalletGlobals) : null;
  if (globals?.wallet) return globals.wallet;

  const provider = new WalletProvider(options);
  if (globals) {
    Object.defineProperty(window, 'wallet', {
      value: provider,
      configurable: false,
      writable: false,
    });
    if (options.alsoAsOctra !== false) {
      try {
        Object.defineProperty(window, 'octra', { value: provider, configurable: false });
      } catch {
        /* ignore if already defined */
      }
    }
    if (options.announce !== false) {
      window.dispatchEvent(new CustomEvent('octra:wallet#initialized', { detail: { provider } }));
    }
  }
  return provider;
}
