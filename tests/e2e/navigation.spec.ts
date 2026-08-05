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
    await expect(page.locator('.card-title').filter({ hasText: 'Smart Contracts' })).toBeVisible();
    // Tab bar has Deploy and Call tabs
    await expect(page.locator('.tab-bar .tab').filter({ hasText: 'Deploy' })).toBeVisible();
    await expect(page.locator('.tab-bar .tab').filter({ hasText: 'Call' })).toBeVisible();
  });

  test('stealth tab shows stealth send', async ({ page }) => {
    await page.click('.nav-item:has-text("Stealth")');
    await expect(page.locator('.card-title').filter({ hasText: 'Stealth Send' })).toBeVisible();
  });

  test('settings tab shows settings', async ({ page }) => {
    await page.click('.nav-item:has-text("Settings")');
    await expect(page.locator('.card-title').filter({ hasText: 'Appearance' })).toBeVisible();
    await expect(page.locator('.card-title').filter({ hasText: 'Network Settings' })).toBeVisible();
    await expect(
      page.locator('.card-title').filter({ hasText: 'Export Private Key' }),
    ).toBeVisible();
    await expect(page.locator('.card-title').filter({ hasText: 'PVAC' })).toBeVisible();
  });

  test('copy address button works', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    // Skip clipboard test on mobile (permissions differ)
    testInfo.skip(testInfo.project.name === 'chromium-mobile', 'Clipboard test desktop-only');

    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    // The copy button has aria-label="Copy" (from i18n common.copy)
    await page.click('button[aria-label="Copy"]');
    await page.waitForTimeout(500);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toMatch(/^oct[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(clipboard.length).toBe(47);
  });
});
