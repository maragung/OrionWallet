import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB } from './helpers';

/**
 * E2E tests for the navigation UI.
 * Updated for the modern UI redesign (sidebar with groups, mobile bottom nav).
 */

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Create a wallet before each test
    await createWallet(page, 'Nav Test', 'Pass1word!abc');
  });

  test('balance tab is shown by default', async ({ page }) => {
    await expect(page.locator('.nav-item.active')).toContainText('Balance');
    await expect(page.locator('text=Public Balance')).toBeVisible();
    await expect(page.locator('text=Wallet Address')).toBeVisible();
  });

  test('send tab shows send form', async ({ page }) => {
    await page.click('.nav-item:has-text("Send")');
    await expect(page.locator('text=Send OCT')).toBeVisible();
    await expect(page.locator('input[id="to"]')).toBeVisible();
    await expect(page.locator('input[id="amount"]')).toBeVisible();
  });

  test('history tab shows history view', async ({ page }) => {
    await page.click('.nav-item:has-text("History")');
    await expect(
      page.locator('.card-title').filter({ hasText: 'Transaction History' }),
    ).toBeVisible();
  });

  test('contracts tab shows deploy/call UI', async ({ page }) => {
    await page.click('.nav-item:has-text("Deploy")');
    /* Every view now opens with a `PageHead` — one `<h1 class="page-title">` — instead of
       putting its name in the first card's `.card-title`. `.card-title` still exists, but
       it names a card inside the page, never the page itself. */
    await expect(page.locator('.page-title')).toContainText('Smart Contracts');
    // Tab bar has Deploy and Call tabs
    await expect(page.locator('.tab-bar .tab').filter({ hasText: 'Deploy' })).toBeVisible();
    await expect(page.locator('.tab-bar .tab').filter({ hasText: 'Call' })).toBeVisible();
  });

  test('stealth tab shows stealth send', async ({ page }) => {
    await page.click('.nav-item:has-text("Stealth")');
    await expect(page.locator('.page-title')).toContainText('Stealth Send');
  });

  test('settings tab shows settings, split into sections', async ({ page }) => {
    await page.click('.nav-item:has-text("Settings")');
    await expect(page.locator('.page-title')).toContainText('Settings');

    // Settings opens on General; these three cards are what that section holds.
    await expect(page.locator('.card-title').filter({ hasText: 'Appearance' })).toBeVisible();
    await expect(page.locator('.card-title').filter({ hasText: 'Network Settings' })).toBeVisible();
    await expect(page.locator('.card-title').filter({ hasText: 'PVAC' })).toBeVisible();

    /* The panel used to be one 1100-line scroll holding all of these at once. The most
       destructive control in the wallet — exporting the raw secret key — is now a
       deliberate two-step: pick Security, then act. */
    await page.getByRole('tab', { name: 'Security' }).click();
    await expect(
      page.locator('.card-title').filter({ hasText: 'Export Private Key' }),
    ).toBeVisible();
  });

  test('copy address button works', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    // Skip clipboard test on mobile (permissions differ)
    testInfo.skip(testInfo.project.name === 'chromium-mobile', 'Clipboard test desktop-only');

    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    /* The address copy button says what it copies. It used to be a bare "Copy", which is
       what a screen reader read out — one of several unlabelled "Copy" buttons on the
       page, with nothing to tell them apart. */
    await page.click('button[aria-label="Copy address"]');
    await page.waitForTimeout(500);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toMatch(/^oct[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(clipboard.length).toBe(47);
  });
});
