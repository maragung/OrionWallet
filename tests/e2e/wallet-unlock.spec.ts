import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB } from './helpers';

/**
 * E2E tests for the wallet unlock flow.
 * Updated for the modern UI redesign.
 */

test.describe('Wallet Unlock Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('user can unlock a previously created wallet', async ({ page }) => {
    // Step 1: Create a wallet (so there's something to unlock)
    await createWallet(page, 'Unlock E2E', 'Pass1word!abc');

    // Verify we're in the main app
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 5_000 });

    // Step 2: Lock the wallet
    await page.click('button[aria-label="Lock"]');

    // Wait a moment for the lock to take effect
    await page.waitForTimeout(500);

    // Should see the unlock screen
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 });
    const heading = await page.locator('h1').textContent();
    expect(heading).toContain('Welcome Back');

    // Step 3: Unlock with correct PIN
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.click('button:has-text("Unlock Wallet")');

    // Should be back in the wallet view
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Public Balance')).toBeVisible();
  });

  test('wrong PIN shows error', async ({ page }) => {
    test.setTimeout(60_000);
    // Create a wallet first
    await createWallet(page, 'Wrong PIN E2E', 'Pass1word!abc');

    // Lock - wait for unlock screen to appear
    await page.click('button[aria-label="Lock"]');
    await page.waitForSelector('h1:has-text("Welcome Back")', { timeout: 15_000 });

    // Try wrong PIN
    await page.fill('input[id="pin"]', 'WrongPin123!');
    await page.click('button:has-text("Unlock Wallet")');

    // Wait for error in processing modal or toast
    await page.waitForTimeout(3000);
    // Check for error text (in modal or toast)
    const errorEl = page.locator('text=/Wrong PIN|Unlock failed|decryption failed/i').first();
    await expect(errorEl).toBeVisible({ timeout: 15_000 });
  });
});
