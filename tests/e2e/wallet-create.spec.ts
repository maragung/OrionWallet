import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB, completeMnemonicBackup } from './helpers';

/**
 * E2E tests for the wallet creation flow, including the recovery-phrase backup
 * check that gates activation.
 */

test.describe('Wallet Creation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('user can create a new wallet, see the mnemonic, and confirm it', async ({ page }) => {
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

    // Submit
    await page.click('button:has-text("Create Wallet")');

    // Success modal appears with the phrase revealed behind it
    await page.waitForSelector('text=Save this mnemonic', { timeout: 30_000 });

    // A 12-word phrase should be rendered
    const mnemonicEl = page.locator('[data-testid="mnemonic-words"]');
    await expect(mnemonicEl).toBeVisible({ timeout: 5_000 });
    const mnemonicText = (await mnemonicEl.textContent()) ?? '';
    const words = mnemonicText
      .trim()
      .split(/\s+/)
      .filter((w) => /^[a-z]+$/.test(w));
    expect(words.length).toBe(12);

    // Creation alone must not open the wallet — the backup check gates it.
    await expect(page.locator('.app-header')).toHaveCount(0);

    await completeMnemonicBackup(page);

    // Should be redirected to the wallet view (balance tab)
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=Public Balance')).toBeVisible();
  });

  test('wrong words keep the wallet closed', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.fill('input[id="pin2"]', 'Pass1word!abc');
    await page.click('button:has-text("Create Wallet")');
    await page.waitForSelector('text=Save this mnemonic', { timeout: 30_000 });

    const gotIt = page.locator('button:has-text("Got It")');
    if (await gotIt.count()) await gotIt.first().click();
    await page.click('button:has-text("Written It Down")');

    const inputs = page.locator('input[data-word-index]');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      // "zzz" is not in the BIP39 wordlist, so it can never be the right answer.
      await inputs.nth(i).fill('zzz');
    }
    await page.click('button:has-text("Confirm")');

    await expect(page.locator('.toast.error')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.app-header')).toHaveCount(0);

    // The real words still work afterwards — the check is not one-shot.
    await page.click('button:has-text("Show Phrase Again")');
    await completeMnemonicBackup(page);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 15_000 });
  });

  test('createWallet helper drives the whole flow', async ({ page }) => {
    test.setTimeout(60_000);
    await createWallet(page, 'Helper Wallet');
    await expect(page.locator('.app-header')).toBeVisible();
  });

  test('PIN confirmation mismatch shows error', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');

    await page.fill('input[id="name"]', 'Mismatch Test');
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.fill('input[id="pin2"]', 'Different1!');
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
    await page.click('button:has-text("Create Wallet")');

    await expect(page.locator('.toast.error')).toBeVisible({ timeout: 5_000 });
  });
});
