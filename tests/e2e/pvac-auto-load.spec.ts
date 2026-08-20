import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB, completeMnemonicBackup } from './helpers';

/**
 * PVAC health is no longer a `.tag` pinned in the header. It sits in the header overflow
 * menu as a labelled row — the same place at every width, where the old tag was hidden
 * below 768px, which is the width where an unreachable status matters most.
 */
async function expectPvacRow(page: import('@playwright/test').Page): Promise<void> {
  await page.click('[data-testid="header-menu-trigger"]');
  await expect(page.locator('.menu-panel .menu-item').filter({ hasText: /PVAC/ })).toBeVisible({
    timeout: 10_000,
  });
  // Close it again, so the portalled panel cannot swallow the next click.
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu-panel')).toHaveCount(0);
}

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

  test('PVAC status is reachable from the header after wallet creation', async ({ page }) => {
    await createWallet(page, 'PVAC Test', 'Pass1word!abc');
    await expectPvacRow(page);
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

    // Lock *after* the module has reported in — locking mid-load was the original bug.
    await expectPvacRow(page);

    await page.click('button[aria-label="Lock wallet"]');
    await expect(page.locator('h1:has-text("Welcome Back")')).toBeVisible();
  });

  test('toast notification appears on wallet creation mentioning PVAC', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');
    await page.fill('input[id="name"]', 'PVAC Toast');
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.fill('input[id="pin2"]', 'Pass1word!abc');
    await page.click('button:has-text("Create Wallet")');

    // Creation succeeded; the wallet is not open yet.
    await expect(page.locator('.toast.success').filter({ hasText: /Wallet created/i })).toBeVisible(
      { timeout: 30_000 },
    );

    /* The wallet only activates once the recovery phrase has been read back, and that is
       what triggers the PVAC load. This step used to be a checkbox and a "View Mnemonic"
       button, neither of which has existed for some time — the assertions below never ran. */
    await completeMnemonicBackup(page);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

    // PVAC loading toast
    await expect(page.locator('.toast').filter({ hasText: /PVAC WASM loading/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
