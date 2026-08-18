import type { Page } from '@playwright/test';

/**
 * E2E test helpers — shared across spec files.
 */

/**
 * Create a wallet end-to-end:
 *   1. Click "Create New Wallet"
 *   2. Fill name, PIN, confirm PIN
 *   3. Click "Create Wallet"
 *   4. Dismiss the success modal, read the revealed phrase
 *   5. Complete the backup check by retyping the requested words
 *   6. Wait for the main app header to appear (wallet activates on confirm)
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

  // Submit
  await page.click('button:has-text("Create Wallet")');

  // Wait for the mnemonic reveal to appear (creation succeeded)
  await page.waitForSelector('text=Save this mnemonic', { timeout: 30_000 });

  await completeMnemonicBackup(page);

  // The wallet activates once the backup check passes; wait for the main app.
  await page.waitForSelector('.app-header', { timeout: 30_000 });
}

/**
 * Walk the post-creation backup flow: dismiss the success modal, read the
 * generated phrase, then retype whichever words the quiz asks for.
 *
 * The words are chosen at random per run, so the positions are read back from
 * each input's `data-word-index` instead of being hardcoded.
 */
export async function completeMnemonicBackup(page: Page): Promise<void> {
  // The success modal sits over the card; close it before clicking behind it.
  const gotIt = page.locator('button:has-text("Got It")');
  if (await gotIt.count()) await gotIt.first().click();

  const phrase = ((await page.textContent('[data-testid="mnemonic-words"]')) ?? '').trim();
  if (!phrase) throw new Error('completeMnemonicBackup: no phrase was rendered');
  const words = phrase.split(/\s+/);

  await page.click('button:has-text("Written It Down")');

  const inputs = page.locator('input[data-word-index]');
  const count = await inputs.count();
  if (count === 0) throw new Error('completeMnemonicBackup: no verification inputs rendered');
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const attr = await input.getAttribute('data-word-index');
    const idx = Number(attr);
    const word = words[idx];
    if (!word) throw new Error(`completeMnemonicBackup: no word at index ${attr}`);
    await input.fill(word);
  }

  await page.click('button:has-text("Confirm")');
}

/**
 * Clear IndexedDB (and this tab's unlock session) to ensure a clean state.
 * Useful in beforeEach hooks.
 *
 * NOTE: After calling this, you MUST reload the page for the change to take
 * effect. Use clearIndexedDBAndReload() for convenience.
 */
export async function clearIndexedDB(page: Page): Promise<void> {
  await page.evaluate(() => {
    // The sealed unlock session lives in sessionStorage; leaving it behind would
    // let a "clean" page reload straight back into an unlocked wallet.
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
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
