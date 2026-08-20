import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConnectApp } from './connect/ConnectApp';
import { I18nProvider } from './i18n/useI18n';
import { MAIN_WALLET_NAME } from './connect/handoff';
import { applyThemeColorMeta } from './styles/theme-colors';
import './styles/global.css';

// Apply theme as early as possible to avoid FOUC (flash of unstyled content).
// The persisted theme is in IndexedDB, but we can apply a sensible default
// (system theme) immediately. The useTheme hook will refine it after
// settings load.
(function applyInitialTheme() {
  try {
    const prefersLight =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    const initial = prefersLight ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', initial);
    // Update theme-color meta for mobile browser chrome
    applyThemeColorMeta(initial);
  } catch {
    // Ignore — defaults will apply
  }
})();

// Initialize global error handler
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason);
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

// Route: the wallet SDK opens a popup at /connect. That document must render the
// approval app, not the full wallet. Everything else renders the wallet.
const isConnectRoute = window.location.pathname.replace(/\/+$/, '') === '/connect';

// Give the main wallet window a stable name so a /connect popup can hand its
// session port back to us (see ./connect/handoff). The popup must NOT set this,
// or it would target itself. A presence flag lets the popup skip the handoff
// (and avoid opening a stray blank window) when the main wallet isn't open.
if (!isConnectRoute) {
  try {
    window.name = MAIN_WALLET_NAME;
    const FLAG = 'orion:main-wallet-open';
    localStorage.setItem(FLAG, '1');
    const clear = () => {
      try {
        localStorage.removeItem(FLAG);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', clear);
  } catch {
    /* ignore — handoff falls back to popup hosting */
  }
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary title="Orion Wallet failed to start">
      <I18nProvider>{isConnectRoute ? <ConnectApp /> : <Layout />}</I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
