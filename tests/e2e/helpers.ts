import type { Page } from '@playwright/test';

/**
 * E2E test helpers — shared across spec files.
 */

/**
 * Create a wallet end-to-end:
 *   1. Click "Create New Wallet"
 *   2. Fill name, PIN, confirm PIN
 *   3. Check the confirmation checkbox
 *   4. Click "Create Wallet"
 *   5. Wait for mnemonic to appear
 *   6. Click "Continue" to activate the wallet
 *   7. Wait for the main app header to appear
 *
 * NOTE: This does NOT clear IndexedDB first. Tests that need a clean state
 * should call clearIndexedDB() in a beforeEach hook.
 */
export async function createWallet(
  page: Page,
  name: string = 'Test Wallet',
  pin: string = 'Pass1word!abc',
): Promise<void> {
  // Ensure we're on the unlock screen
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // Click "Create New Wallet"
  await page.click('button:has-text("Create New Wallet")');

  // Fill in form
  await page.fill('input[id="name"]', name);
  await page.fill('input[id="pin"]', pin);
  await page.fill('input[id="pin2"]', pin);

  // Check the confirmation checkbox
  await page.check('input[type="checkbox"]');

  // Submit
  await page.click('button:has-text("Create Wallet")');

  // Wait for processing modal to complete and mnemonic to appear
  await page.waitForSelector('text=Save this mnemonic', { timeout: 30_000 });

  // Dismiss the success modal by clicking "View Mnemonic" button
  const viewMnemonicBtn = page.locator('button:has-text("View Mnemonic")');
  if (await viewMnemonicBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await viewMnemonicBtn.click();
  }

  // Click Continue to activate the wallet
  await page.click('button:has-text("Continue")');

  // Wait for main app to appear
  await page.waitForSelector('.app-header', { timeout: 30_000 });
}

/**
 * Clear IndexedDB to ensure a clean state.
 * Useful in beforeEach hooks.
 *
 * NOTE: After calling this, you MUST reload the page for the change to take
 * effect. Use clearIndexedDBAndReload() for convenience.
 */
export async function clearIndexedDB(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Clear the legacy database too, otherwise the rebrand migration copies it
    // straight back into the new one and the "clean state" is not clean.
    const names = ['orion-wallet', 'webcli-react'];
    return Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }),
      ),
    ).then(() => undefined);
  });
}

/**
 * Clear IndexedDB and reload the page.
 */
export async function clearIndexedDBAndReload(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await clearIndexedDB(page);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}
