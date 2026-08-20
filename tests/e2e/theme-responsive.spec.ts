import { test, expect } from '@playwright/test';
import { createWallet, clearIndexedDB, gotoTab } from './helpers';
import { THEME_COLORS } from '../../src/styles/theme-colors';

/**
 * Theme switching and the responsive contract, against the built app (preview server).
 *
 * This file is the "works on all devices" guardrail, so it asserts the *shape* of each
 * tier rather than pixel values: which navigation surface is on screen, whether the
 * document overflows horizontally, and whether a keyboard user can see where they are.
 *
 * It runs in both Playwright projects. Describes that pin a viewport with `test.use`
 * therefore run twice at the same width, which is intentional — the mobile project also
 * emulates touch and a 3× DPR, and a few of these rules are `(pointer: coarse)` rules.
 * Describes without `test.use` run at 1280 and at 390, so anything in them must work at
 * both widths; use `gotoTab()` rather than a hardcoded `.nav-item` selector there.
 */

/** Every width the design claims to support, plus the two tier boundaries. */
const TIER_WIDTHS = [320, 390, 768, 900, 1024, 1280, 1600];

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

  /* The expected values are imported, not written out: they used to be hardcoded here
     as well as in three source files, so a palette change left this test asserting the
     old colour and passing against nothing real. */
  test('theme-color meta tag tracks the theme', async ({ page }) => {
    await page.goto('/');
    const metaColor = () =>
      page.evaluate(() =>
        document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
      );

    expect(await metaColor()).toBe(THEME_COLORS.dark);

    await page.click('button[aria-label="Toggle theme"]');
    await page.waitForTimeout(300);

    expect(await metaColor()).toBe(THEME_COLORS.light);
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

    await gotoTab(page, 'Settings');

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

test.describe('Responsive Layout — Desktop (1280px)', () => {
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

  /* Asserted as the label list rather than a count: when someone adds a view, the
     failure names the item that appeared instead of just "expected 13, got 14". */
  test('sidebar shows every view, grouped, with labels', async ({ page }) => {
    await createWallet(page, 'Nav Test', 'Pass1word!abc');

    const groups = await page.locator('.nav-group-label').allTextContents();
    expect(groups).toEqual(['Wallet', 'Privacy', 'Contracts', 'Advanced']);

    const labels = (await page.locator('.nav-item').allTextContents()).map((s) => s.trim());
    expect(labels).toEqual([
      'Balance',
      'Send',
      'Receive',
      'History',
      'Tokens',
      'Private',
      'Stealth',
      'Deploy',
      'Viewer',
      'Browser',
      'Circles',
      'Settings',
      'Docs',
    ]);
  });

  test('balance view leads with the gradient hero', async ({ page }) => {
    await createWallet(page, 'Hero Test', 'Pass1word!abc');

    const hero = page.locator('.hero-balance');
    await expect(hero).toBeVisible();
    // The hero is the page's first block, above every card.
    const heroTop = (await hero.boundingBox())!.y;
    const firstCardTop = (await page.locator('.app-main .card').first().boundingBox())!.y;
    expect(heroTop).toBeLessThan(firstCardTop);
  });
});

/**
 * 768–1023px used to fall into the phone block, so an iPad in portrait got a phone
 * bottom bar. It now gets a collapsed icon rail: the sidebar stays, the labels go.
 */
test.describe('Responsive Layout — Tablet rail (900px)', () => {
  test.use({ viewport: { width: 900, height: 1000 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  test('rail replaces the sidebar, not the navigation', async ({ page }) => {
    await createWallet(page, 'Rail Test', 'Pass1word!abc');

    await expect(page.locator('.app-sidebar')).toBeVisible();
    await expect(page.locator('.mobile-nav')).toBeHidden();

    // The rail is as wide as the token says, so the grid column and the token cannot drift.
    const expected = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')),
    );
    const width = (await page.locator('.app-sidebar').boundingBox())!.width;
    expect(Math.abs(width - expected)).toBeLessThanOrEqual(1);

    // Labels are hidden, group headings collapse to a hairline…
    await expect(page.locator('.nav-item > span:not(.icon)').first()).toBeHidden();
    const labelHeight = (await page.locator('.nav-group-label').first().boundingBox())!.height;
    expect(labelHeight).toBeLessThanOrEqual(2);

    // …so `aria-label` is the only remaining accessible name for a rail item.
    const names = await page
      .locator('.nav-item')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    expect(names).toHaveLength(13);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });
});

test.describe('Responsive Layout — Tablet (iPad portrait, 768px)', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  });

  /* 768 is the first width above the phone breakpoint. The old assertion here was
     `sidebarVisible || mobileNavVisible`, which is true of every width the app has
     and so could not fail. */
  test('768px is a rail, not a phone', async ({ page }) => {
    await createWallet(page, 'Tablet Test', 'Pass1word!abc');

    await expect(page.locator('.app-sidebar')).toBeVisible();
    await expect(page.locator('.mobile-nav')).toBeHidden();
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

  test('bottom bar has exactly 5 slots and does not scroll sideways', async ({ page }) => {
    await createWallet(page, 'Mobile Nav Test', 'Pass1word!abc');

    const mobileNavItems = page.locator('.mobile-nav-item');
    expect(await mobileNavItems.count()).toBe(5);

    const labels = await mobileNavItems.locator('.label').allTextContents();
    expect(labels).toEqual(['Home', 'Send', 'Receive', 'History', 'More']);

    /* The six-slot version overflowed a narrow phone into a horizontal scroll with no
       scrollbar, so the last item was simply unreachable. `overflow-x: hidden` stops
       the scroll; this asserts the stronger property that the slots actually fit. */
    const fits = await page
      .locator('.mobile-nav')
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
  });

  test('everything not in the bar is reachable through "More"', async ({ page }) => {
    await createWallet(page, 'Sheet Test', 'Pass1word!abc');

    await page.locator('.mobile-nav-item:has-text("More")').click();
    const sheetLabels = await page.locator('.sheet-item').allTextContents();
    expect(sheetLabels.map((s) => s.trim())).toEqual([
      'Tokens',
      'Private',
      'Stealth',
      'Deploy',
      'Viewer',
      'Browser',
      'Circles',
      'Settings',
      'Docs',
    ]);
  });

  test('tapping mobile nav items switches views', async ({ page }) => {
    await createWallet(page, 'Mobile Tap', 'Pass1word!abc');

    await page.click('.mobile-nav-item:has-text("Send")');
    await expect(page.locator('.card-title').filter({ hasText: 'Send OCT' })).toBeVisible({
      timeout: 5000,
    });

    await page.click('.mobile-nav-item:has-text("History")');
    await expect(
      page.locator('.card-title').filter({ hasText: 'Transaction History' }),
    ).toBeVisible({ timeout: 5000 });

    // Settings is behind "More" at this width.
    await gotoTab(page, 'Settings');
    await expect(page.locator('.card-title').filter({ hasText: 'Network Settings' })).toBeVisible({
      timeout: 5000,
    });
  });

  /* Two separate contracts. A `.stacked` footer is a column at every width (the
     create-wallet screen, where the primary action is the whole point of the screen);
     a plain footer is a right-aligned row that becomes `column-reverse` under 768px,
     so the primary action lands under the thumb and Cancel does not take its place. */
  test('the create-wallet footer stacks, primary action first', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');

    const footer = page.locator('.form-actions.stacked').first();
    await expect(footer).toBeVisible();
    expect(await footer.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('column');

    const footerWidth = (await footer.boundingBox())!.width;
    const buttonWidth = (await footer.locator('button').first().boundingBox())!.width;
    expect(Math.abs(buttonWidth - footerWidth)).toBeLessThanOrEqual(1);
  });

  test('a row of form actions reverses and goes full-width on a phone', async ({ page }) => {
    test.setTimeout(60_000);
    await createWallet(page, 'Actions Test', 'Pass1word!abc');
    await page.click('.mobile-nav-item:has-text("Send")');

    const footer = page.locator('.form-actions:not(.stacked):not(.start)').first();
    await expect(footer).toBeVisible();
    expect(await footer.evaluate((el) => getComputedStyle(el).flexDirection)).toBe(
      'column-reverse',
    );

    const footerWidth = (await footer.boundingBox())!.width;
    const buttonWidth = (await footer.locator('button').first().boundingBox())!.width;
    expect(Math.abs(buttonWidth - footerWidth)).toBeLessThanOrEqual(1);
  });
});

/**
 * The primary button is the only element in the wallet that carries the accent gradient,
 * and it is the one users are about to click. Its states are asserted rather than eyeballed
 * because the way it broke is invisible in a static screenshot: the generic
 * `button:hover:not(:disabled)` rule is specificity (0,2,1) against `button.primary`'s
 * (0,1,1), so it won on hover, and being a `background` shorthand it reset
 * `background-image` to `none` — the gradient vanished the moment the pointer arrived and
 * the main action went flat grey. Only the *interaction* states show it.
 */
test.describe('Primary action styling', () => {
  /** Resolved background-image of the create-wallet submit button, right now. */
  const bgImage = (button: import('@playwright/test').Locator) =>
    button.evaluate((el) => getComputedStyle(el).backgroundImage);

  test('the primary button keeps its gradient at rest, on hover and while pressed', async ({
    page,
  }) => {
    await page.goto('/');
    await page.click('button:has-text("Create New Wallet")');
    // Fill the form so the button is enabled: the state rules are all `:not(:disabled)`.
    await page.fill('input[id="name"]', 'Gradient Test');
    await page.fill('input[id="pin"]', 'Pass1word!abc');
    await page.fill('input[id="pin2"]', 'Pass1word!abc');

    const primary = page.locator('button.primary:has-text("Create Wallet")').first();
    await expect(primary).toBeEnabled();

    // Park the pointer away from the card first — otherwise "at rest" may already be hover.
    await page.mouse.move(2, 2);
    expect(await bgImage(primary)).toContain('linear-gradient');

    await primary.hover();
    expect(await bgImage(primary)).toContain('linear-gradient');

    /* Pressed, held via the keyboard rather than the mouse: `:active` without `:hover` is
       the combination the generic `button:active:not(:disabled)` rule used to win, and it
       is the one a keyboard user gets every single time.

       Focus is dropped before the key is released, because `keyup` on a focused submit
       button *is* the click — releasing it here would start a real wallet creation, and a
       styling test has no business generating a mnemonic. */
    await primary.focus();
    await page.keyboard.down(' ');
    expect(await bgImage(primary)).toContain('linear-gradient');
    await primary.evaluate((el) => (el as HTMLElement).blur());
    await page.keyboard.up(' ');
  });
});

/**
 * A horizontal document scrollbar is the failure mode this redesign exists to fix: at
 * 320px the old grid measured 371px wide, which is what cut off the last nav slot.
 * One wallet, resized — creating one per width would triple the suite's runtime.
 */
test.describe('No horizontal overflow', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test(`document never scrolls sideways at ${TIER_WIDTHS.join(' / ')}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await clearIndexedDB(page);
    await page.reload();
    await createWallet(page, 'Overflow Test', 'Pass1word!abc');

    for (const width of TIER_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      // Let the media queries settle and the grid re-lay-out.
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      expect(
        overflow.scrollWidth,
        `document overflows by ${overflow.scrollWidth - overflow.clientWidth}px at ${width}px`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  });
});

test.describe('Keyboard focus', () => {
  /* `outline: none` on inputs left keyboard users with no focus indicator at all, and
     the sidebar's `role="button"` divs had only the UA default. There is now one
     `:focus-visible` rule using `--ring`; this asserts a real Tab press produces it. */
  test('tabbing shows a visible focus ring', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await page.keyboard.press('Tab');

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, boxShadow: cs.boxShadow, outline: cs.outlineStyle };
    });

    expect(focused, 'Tab moved focus off <body>').not.toBeNull();
    expect(
      focused!.boxShadow !== 'none' || focused!.outline !== 'none',
      `focused <${focused!.tag}> has no ring: box-shadow=${focused!.boxShadow}`,
    ).toBe(true);
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
