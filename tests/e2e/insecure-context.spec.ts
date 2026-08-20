import { test, expect } from '@playwright/test';
import { completeMnemonicBackup } from './helpers';

/**
 * Verify the "Cannot read properties of undefined (reading 'importKey')" bug
 * is fixed: force a NON-SECURE context (crypto.subtle removed) and create a
 * wallet end-to-end. This reproduces plain-HTTP-on-public-IP access.
 */
test('wallet creation works with crypto.subtle unavailable (non-secure ctx)', async ({ page }) => {
  test.setTimeout(60_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });

  // Remove crypto.subtle BEFORE any app code runs, simulating insecure context.
  await page.addInitScript(() => {
    try {
      Object.defineProperty(window.crypto, 'subtle', {
        configurable: true,
        get: () => undefined,
      });
    } catch {
      // ignore
    }
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // Confirm subtle is really gone in the page context.
  const subtleGone = await page.evaluate(() => typeof window.crypto.subtle === 'undefined');
  expect(subtleGone, 'crypto.subtle should be undefined in this test').toBe(true);

  // Create a wallet (this hits PBKDF2 + AES-GCM which previously threw importKey).
  await page.click('button:has-text("Create New Wallet")');
  await page.fill('input[id="name"]', 'HTTP Fallback');
  await page.fill('input[id="pin"]', 'Pass1word!abc');
  await page.fill('input[id="pin2"]', 'Pass1word!abc');
  await page.click('button:has-text("Create Wallet")');

  // Wallet must be created successfully (mnemonic screen appears).
  await expect(page.locator('text=Save this mnemonic')).toBeVisible({ timeout: 30_000 });

  /* Walking the backup flow is the point, not incidental: confirming the phrase decrypts
     and re-encrypts the vault, so it exercises the same PBKDF2 + AES-GCM fallback path a
     second time. The "View Mnemonic" button this used to click has not existed for some
     time, and neither has the acknowledgement checkbox above. */
  await completeMnemonicBackup(page);
  await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

  const importKeyErrors = errors.filter((e) => /importKey/i.test(e));
  console.log('=== ALL ERRORS ===\n' + (errors.join('\n') || '(none)'));
  expect(importKeyErrors, `importKey errors: ${JSON.stringify(importKeyErrors)}`).toEqual([]);
});
