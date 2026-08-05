import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB } from './helpers';

/**
 * E2E tests for PVAC WASM auto-load flow.
 * Updated for the modern UI redesign.
 */

test.describe('PVAC Auto-Load', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('PVAC status indicator appears in header after wallet creation', async ({ page }) => {
    await createWallet(page, 'PVAC Test', 'Pass1word!abc');

    // The header should show a PVAC indicator tag
    await expect(
      page.locator('.app-header').locator('.tag').filter({ hasText: /PVAC/ }),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Settings panel shows PVAC auto-load status', async ({ page }) => {
    await createWallet(page, 'PVAC Settings Test', 'Pass1word!abc');

    await page.click('.nav-item:has-text("Settings")');
    await expect(
      page.locator('.card-title').filter({ hasText: 'PVAC (FHE) Module' }),
    ).toBeVisible();
    await expect(page.locator('text=How auto-load works')).toBeVisible();
  });

  test('Settings shows "How auto-load works" explainer', async ({ page }) => {
    await createWallet(page, 'PVAC Explain', 'Pass1word!abc');

    await page.click('.nav-item:has-text("Settings")');
    await expect(page.locator('text=How auto-load works')).toBeVisible();
  });

  test('Reload PVAC button is present and clickable', async ({ page }) => {
    await createWallet(page, 'PVAC Reload', 'Pass1word!abc');

    await page.click('.nav-item:has-text("Settings")');
    const reloadBtn = page.locator('button:has-text("Reload PVAC")');
    await expect(reloadBtn).toBeVisible();
    await reloadBtn.click();
  });

  test('Locking the wallet returns to unlock screen', async ({ page }) => {
    await createWallet(page, 'PVAC Lock Test', 'Pass1word!abc');

    await expect(
      page.locator('.app-header').locator('.tag').filter({ hasText: /PVAC/ }),
    ).toBeVisible({
      timeout: 10_000,
    });

    await page.click('button[aria-label="Lock"]');
    await expect(page.locator('h1:has-text("Welcome Back")')).toBeVisible();
  });

  test('toast notification appears on wallet creation mentioning PVAC', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');
    await page.fill('input[id="name"]', 'PVAC Toast');
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.fill('input[id="pin2"]', 'Pass1word!abc');
    await page.check('input[type="checkbox"]');
    await page.click('button:has-text("Create Wallet")');

    // Wallet created toast (PVAC load happens after Continue)
    await expect(page.locator('.toast.success').filter({ hasText: /Wallet created/i })).toBeVisible(
      { timeout: 30_000 },
    );

    // Dismiss the success modal by clicking "View Mnemonic" button
    const viewMnemonicBtn = page.locator('button:has-text("View Mnemonic")');
    if (await viewMnemonicBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await viewMnemonicBtn.click();
    }

    // Click Continue to activate wallet (triggers PVAC load)
    await page.click('button:has-text("Continue")');
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

    // PVAC loading toast
    await expect(page.locator('.toast').filter({ hasText: /PVAC WASM loading/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
