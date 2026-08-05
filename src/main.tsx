import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConnectApp } from './connect/ConnectApp';
import { I18nProvider } from './i18n/useI18n';
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
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', initial === 'light' ? '#fafafa' : '#0a0a0f');
    }
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

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary title="Orion Wallet failed to start">
      <I18nProvider>{isConnectRoute ? <ConnectApp /> : <Layout />}</I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
