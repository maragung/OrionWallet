import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB } from './helpers';

/**
 * E2E tests for the wallet creation flow.
 * Updated for the modern UI redesign (mobile-first, theme toggle, etc.).
 */

test.describe('Wallet Creation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('user can create a new wallet and see the mnemonic', async ({ page }) => {
    test.setTimeout(60_000); // Processing modal adds delay
    await page.goto('/');

    // Should land on unlock screen (now shows "Welcome Back")
    await expect(page.locator('h1:has-text("Welcome Back")')).toBeVisible();

    // Click "Create New Wallet"
    await page.click('button:has-text("Create New Wallet")');

    // Should be on the Create Wallet screen
    await expect(page.locator('h1:has-text("Create New Wallet")')).toBeVisible();

    // Fill in PIN (account name already has default "Account 1")
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.fill('input[id="pin2"]', 'Pass1word!abc');

    // Check the confirmation checkbox
    await page.check('input[type="checkbox"]');

    // Submit
    await page.click('button:has-text("Create Wallet")');

    // Wait for processing modal to show success, then click "View Mnemonic"
    await page.waitForSelector('text=Save this mnemonic', { timeout: 30_000 });

    // Dismiss the success modal by clicking "View Mnemonic" button
    const viewMnemonicBtn = page.locator('button:has-text("View Mnemonic")');
    if (await viewMnemonicBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await viewMnemonicBtn.click();
    }

    // Should have a 12-word mnemonic displayed (in .mono element)
    const mnemonicEl = page
      .locator('.mono')
      .filter({ hasText: /\b\w+\s+\w+\s+\w+/ })
      .first();
    await expect(mnemonicEl).toBeVisible({ timeout: 5_000 });
    const mnemonicText = await mnemonicEl.textContent();
    expect(mnemonicText).toBeTruthy();
    // The mnemonic should be 12 words (filter out any non-mnemonic .mono elements)
    const words = mnemonicText!
      .trim()
      .split(/\s+/)
      .filter((w) => /^[a-z]+$/.test(w));
    expect(words.length).toBe(12);

    // Click Continue to activate the wallet
    await page.click('button:has-text("Continue")');

    // Should be redirected to the wallet view (balance tab)
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=Public Balance')).toBeVisible();
  });

  test('PIN confirmation mismatch shows error', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');

    await page.fill('input[id="name"]', 'Mismatch Test');
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.fill('input[id="pin2"]', 'Different1!');
    await page.check('input[type="checkbox"]');
    await page.click('button:has-text("Create Wallet")');

    // Should see toast error
    await expect(page.locator('.toast.error')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.toast.error')).toContainText('PINs do not match');
  });

  test('weak PIN is rejected', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');

    await page.fill('input[id="name"]', 'Weak Test');
    await page.fill('input[id="pin"]', 'short');
    await page.fill('input[id="pin2"]', 'short');
    await page.check('input[type="checkbox"]');
    await page.click('button:has-text("Create Wallet")');

    await expect(page.locator('.toast.error')).toBeVisible({ timeout: 5_000 });
  });
});

// Use the helper to silence unused import warning
void createWallet;
