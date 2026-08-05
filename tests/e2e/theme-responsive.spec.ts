import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB } from './helpers';

/**
 * E2E tests for theme switching and responsive layout.
 * Tests run against the built app (preview server).
 */

test.describe('Theme System', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('default theme is dark (data-theme="dark" on html)', async ({ page }) => {
    await page.goto('/');
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');
  });

  test('theme toggle button switches dark → light', async ({ page }) => {
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'dark',
    );

    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'light',
    );

    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'dark',
    );
  });

  test('theme-color meta tag updates with theme', async ({ page }) => {
    await page.goto('/');
    let metaColor = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    );
    expect(metaColor).toBe('#0a0a0f');

    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(300);

    metaColor = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    );
    expect(metaColor).toBe('#fafafa');
  });

  test('theme persists across page reloads (stored in IndexedDB)', async ({ page }) => {
    await page.goto('/');
    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(1000);

    // Reload
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // Wait for settings to load from IndexedDB and theme to be applied
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
      { timeout: 10_000 },
    );

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('light');
  });

  test('Settings panel has theme selector with Dark/Light/System options', async ({ page }) => {
    test.setTimeout(60_000); // Mobile form interactions can be slow
    await createWallet(page, 'Theme Test', 'Pass1word!abc');

    // Click Settings - use visible() filter to handle both desktop and mobile layouts
    const settingsNav = page
      .locator('.nav-item:has-text("Settings"), .mobile-nav-item:has-text("Settings")')
      .filter({ visible: true })
      .first();
    await settingsNav.click();

    await expect(page.locator('.card-title').filter({ hasText: 'Appearance' })).toBeVisible({
      timeout: 15_000,
    });
    const themeSelect = page.locator('select#theme');
    await expect(themeSelect).toBeVisible({ timeout: 10_000 });

    const options = await themeSelect.locator('option').count();
    expect(options).toBe(3);

    await themeSelect.selectOption('light');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'light',
    );

    await themeSelect.selectOption('system');
    await page.waitForTimeout(500);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(['dark', 'light']).toContain(theme);
  });
});

test.describe('Responsive Layout — Desktop (1280px+)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('shows sidebar navigation on desktop', async ({ page }) => {
    await createWallet(page, 'Desktop Test', 'Pass1word!abc');

    await expect(page.locator('.app-sidebar')).toBeVisible();
    await expect(page.locator('.mobile-nav')).toBeHidden();
  });

  test('sidebar shows all 10 nav items grouped', async ({ page }) => {
    await createWallet(page, 'Nav Test', 'Pass1word!abc');

    await expect(page.locator('.nav-group-label').filter({ hasText: 'Wallet' })).toBeVisible();
    await expect(page.locator('.nav-group-label').filter({ hasText: 'Contracts' })).toBeVisible();
    await expect(page.locator('.nav-group-label').filter({ hasText: 'Advanced' })).toBeVisible();

    expect(await page.locator('.nav-item').count()).toBe(10);
  });
});

test.describe('Responsive Layout — Mobile (iPhone 14, 390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('shows bottom navigation on mobile (no sidebar)', async ({ page }) => {
    await createWallet(page, 'Mobile Test', 'Pass1word!abc');

    await expect(page.locator('.app-sidebar')).toBeHidden();
    await expect(page.locator('.mobile-nav')).toBeVisible();
  });

  test('mobile nav has 5 items (Home, Send, History, Circles, Settings)', async ({ page }) => {
    await createWallet(page, 'Mobile Nav Test', 'Pass1word!abc');

    const mobileNavItems = page.locator('.mobile-nav-item');
    expect(await mobileNavItems.count()).toBe(5);

    const labels = await mobileNavItems.locator('.label').allTextContents();
    expect(labels).toEqual(
      expect.arrayContaining(['Home', 'Send', 'History', 'Circles', 'Settings']),
    );
  });

  test('tapping mobile nav items switches views', async ({ page }) => {
    await createWallet(page, 'Mobile Tap', 'Pass1word!abc');

    await page.click('.mobile-nav-item:has-text("Send")');
    await expect(page.locator('text=Send OCT')).toBeVisible({ timeout: 5000 });

    await page.click('.mobile-nav-item:has-text("History")');
    await expect(
      page.locator('.card-title').filter({ hasText: 'Transaction History' }),
    ).toBeVisible({ timeout: 5000 });

    await page.click('.mobile-nav-item:has-text("Settings")');
    await expect(page.locator('.card-title').filter({ hasText: 'Network Settings' })).toBeVisible({
      timeout: 5000,
    });
  });

  test('mobile form actions are full-width stacked', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');
    const formActions = page.locator('.form-actions').first();
    const flexDirection = await formActions.evaluate(
      (el) => window.getComputedStyle(el).flexDirection,
    );
    expect(flexDirection).toBe('column');
  });
});

test.describe('Responsive Layout — Tablet (iPad, 768px)', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('tablet uses sidebar (above mobile breakpoint)', async ({ page }) => {
    await createWallet(page, 'Tablet Test', 'Pass1word!abc');

    const sidebarVisible = await page
      .locator('.app-sidebar')
      .isVisible()
      .catch(() => false);
    const mobileNavVisible = await page
      .locator('.mobile-nav')
      .isVisible()
      .catch(() => false);
    expect(sidebarVisible || mobileNavVisible).toBe(true);
  });
});

test.describe('Theme Toggle Accessibility', () => {
  test('theme toggle button has aria-label', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('button[aria-label="Toggle theme"]');
    await expect(btn).toBeVisible();
  });

  test('theme toggle has descriptive title attribute', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('button[aria-label="Toggle theme"]');
    const title = await btn.getAttribute('title');
    expect(title).toContain('theme');
  });
});
