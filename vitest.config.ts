import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), wasm()],
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
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    // Retry flaky tests up to 2 times on CI, 0 locally for fast feedback
    retry: process.env.CI ? 2 : 0,
    // Bail after 5 failures to avoid wasting time on cascading errors
    bail: process.env.CI ? 5 : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      exclude: [
        'tests/**',
        'scripts/**',
        'playwright.config.ts',
        'vite.config.ts',
        'vitest.config.ts',
        'src/**/*.d.ts',
        'src/main.tsx',
      ],
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
});
