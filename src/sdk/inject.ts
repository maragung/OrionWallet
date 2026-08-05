/**
 * Attaches a WalletProvider instance to `window.wallet` and announces it,
 * MetaMask-style, so dApps can detect it without polling.
 */
import { WalletProvider, type WalletProviderOptions } from './WalletProvider';

declare global {
  interface Window {
    wallet?: WalletProvider;
    octra?: WalletProvider;
  }
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
  if (typeof window !== 'undefined' && window.wallet) return window.wallet;

  const provider = new WalletProvider(options);
  if (typeof window !== 'undefined') {
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
