import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { fileURLToPath, URL } from 'node:url';

/**
 * Widen the shipped CSP to allow plain-http RPC endpoints.
 *
 * `index.html` ships `connect-src 'self' https:` plus loopback, so a node on a
 * LAN address over http:// is blocked before the request leaves the tab. A
 * meta-tag CSP cannot be loosened at runtime, so self-hosters who need one build
 * with `VITE_ALLOW_HTTP_ENDPOINTS=1` and this appends `http:` to that directive.
 * The runtime still requires the user to trust each origin — see
 * src/wallet/endpoint-policy.ts.
 */
function allowHttpEndpointsCsp(): Plugin {
  const flag = process.env.VITE_ALLOW_HTTP_ENDPOINTS;
  const enabled = flag === '1' || flag === 'true';
  return {
    name: 'orion-allow-http-endpoints-csp',
    transformIndexHtml(html) {
      if (!enabled) return html;
      return html.replace(/(connect-src[^;"]*)/, '$1 http:');
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), allowHttpEndpointsCsp()],
  base: '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@crypto': fileURLToPath(new URL('./src/crypto', import.meta.url)),
      '@wallet': fileURLToPath(new URL('./src/wallet', import.meta.url)),
      '@tx': fileURLToPath(new URL('./src/tx', import.meta.url)),
      '@rpc': fileURLToPath(new URL('./src/rpc', import.meta.url)),
      '@pvac': fileURLToPath(new URL('./src/pvac', import.meta.url)),
      '@stealth': fileURLToPath(new URL('./src/stealth', import.meta.url)),
      '@api': fileURLToPath(new URL('./src/api', import.meta.url)),
      '@components': fileURLToPath(new URL('./src/components', import.meta.url)),
      '@hooks': fileURLToPath(new URL('./src/hooks', import.meta.url)),
      '@store': fileURLToPath(new URL('./src/store', import.meta.url)),
    },
  },
  optimizeDeps: {
    // No special handling needed; we use @noble/curves (pure ESM) instead
    // of libsodium-wrappers-sumo (which has ESM packaging issues).
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
      output: {
        manualChunks: {
          crypto: ['tweetnacl', '@noble/curves', '@noble/hashes'],
          react: ['react', 'react-dom', 'zustand'],
        },
      },
    },
  },
  server: {
    port: 5173,
    headers: {
      // Required for SharedArrayBuffer (future WASM threading for PVAC)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 4173,
    headers: {
      // COOP/COEP must be unsafe-none for the /connect popup path so that
      // postMessage + MessagePort transfer works. Production deployment
      // handles this via vercel.json per-path overrides.
    },
  },
});
