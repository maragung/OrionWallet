import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration.
 * - CI: 3 retries, 1 worker, 60s timeout, list+html reporter
 * - Local: 0 retries, parallel workers, 30s timeout, list reporter
 */
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: !isCI,
  forbidOnly: isCI,
  retries: isCI ? 3 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI
    ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : [['list'], ['html', { open: 'never' }]],
  // Fail fast on too many failures
  maxFailures: isCI ? 5 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: 'http://localhost:4173',
    trace: isCI ? 'retain-on-failure' : 'on-first-retry',
    screenshot: isCI ? 'only-on-failure' : 'off',
    video: isCI ? 'retain-on-failure' : 'off',
    // Mobile-friendly: emulate real viewport
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
      // Run all tests on desktop
    },
    {
      name: 'chromium-mobile',
      // Use Chromium with mobile viewport (avoids needing webkit browser binary)
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
      // Only run tests explicitly tagged for mobile/responsive/theme
      testMatch: /theme-responsive|mobile/i,
    },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !isCI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
