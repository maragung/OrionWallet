import { test, expect, type Page } from '@playwright/test';
import { createWallet, clearIndexedDBAndReload } from './helpers';

/**
 * E2E cover for the top-bar network pill.
 *
 * Its menu used to be positioned inside the header action row, which is
 * `overflow: hidden` at phone widths: the menu opened, Playwright reported it
 * visible, `click()` on a row "worked" — and not one pixel of it was painted, so
 * to a user the pill was simply dead. `isVisible()` does not model clipping, so
 * the check below hit-tests the menu instead: whatever `elementFromPoint`
 * returns at the menu's own coordinates has to be the menu.
 *
 * The file name carries `mobile` so the 390px Playwright project picks it up.
 */

interface MenuProbe {
  found: boolean;
  rect?: { left: number; top: number; right: number; bottom: number };
  /** For each sampled point: did the hit test land inside the menu? */
  hits?: boolean[];
  /** What the hit test found instead, for diagnosis. */
  hitNames?: string[];
  /** The first ancestor whose clip rect excludes the menu, if any. */
  clippedBy?: string | null;
  viewport?: { width: number; height: number };
}

/** Ask the browser whether the menu is really on screen and really hittable. */
async function probeMenu(page: Page, testId: string): Promise<MenuProbe> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const points: Array<[number, number]> = [
      [r.left + r.width / 2, r.top + 6],
      [r.left + r.width / 2, r.top + r.height / 2],
    ];
    const describeEl = (n: Element | null) =>
      n
        ? `${n.tagName.toLowerCase()}${n.className ? `.${String(n.className).split(/\s+/)[0]}` : ''}`
        : 'null';
    const hitNames: string[] = [];
    const hits = points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      hitNames.push(describeEl(hit));
      return !!hit && (hit === el || el.contains(hit));
    });
    let clippedBy: string | null = null;
    for (let p = el.parentElement; p && !clippedBy; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const clips = [cs.overflow, cs.overflowX, cs.overflowY].some((v) => v !== 'visible');
      if (!clips) continue;
      const pr = p.getBoundingClientRect();
      const outside = r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top;
      if (outside) clippedBy = p.className || p.tagName;
    }
    return {
      found: true,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      hits,
      hitNames,
      clippedBy,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, testId);
}

/** Fail with the measurements, not just "false !== true". */
function expectOnScreen(probe: MenuProbe): void {
  expect(probe.found, 'menu did not render').toBe(true);
  const { rect, viewport } = probe;
  expect(probe.clippedBy ?? null, `menu is clipped by an ancestor: ${probe.clippedBy}`).toBeNull();
  expect(rect!.left, JSON.stringify(probe)).toBeGreaterThanOrEqual(0);
  expect(rect!.top, JSON.stringify(probe)).toBeGreaterThanOrEqual(0);
  expect(rect!.right, JSON.stringify(probe)).toBeLessThanOrEqual(viewport!.width + 1);
  expect(rect!.bottom, JSON.stringify(probe)).toBeLessThanOrEqual(viewport!.height + 1);
  expect(
    probe.hits,
    `menu is not the hit target at its own coordinates: ${JSON.stringify(probe)}`,
  ).toEqual([true, true]);
}

function networkTests(label: string): void {
  test.describe(`Network switcher — ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await clearIndexedDBAndReload(page);
      await createWallet(page, `Net ${label}`, 'Pass1word!abc');
    });

    test('the network menu opens where it can be seen and tapped', async ({ page }) => {
      await page.click('.network-pill');
      await expect(page.locator('[data-testid="network-menu"]')).toBeVisible();
      expectOnScreen(await probeMenu(page, 'network-menu'));
    });

    test('picking a network from the menu switches and persists it', async ({ page }) => {
      const pill = page.locator('.network-pill');
      await expect(pill).toContainText('DEVNET');

      await page.click('.network-pill');
      const menu = page.locator('[data-testid="network-menu"]');
      await expect(menu).toBeVisible();
      // Hit-test first: a click on a clipped row still "succeeds".
      expectOnScreen(await probeMenu(page, 'network-menu'));

      await menu.locator('button', { hasText: 'MAINNET' }).click();

      await expect(pill).toContainText('MAINNET');
      await expect(page.locator('text=Network switched')).toBeVisible();
      await expect(menu).toBeHidden();

      // Persisted, not just held in memory: the session survives a reload.
      await page.reload();
      await page.waitForSelector('.app-header', { timeout: 30_000 });
      await expect(page.locator('.network-pill')).toContainText('MAINNET');
    });

    test('the account menu opens where it can be seen and tapped', async ({ page }) => {
      await page.click('.account-picker-trigger');
      await expect(page.locator('[data-testid="account-menu"]')).toBeVisible();
      expectOnScreen(await probeMenu(page, 'account-menu'));
    });
  });
}

test.describe(() => {
  test.use({ viewport: { width: 1280, height: 720 } });
  networkTests('desktop');
});

test.describe(() => {
  test.use({ viewport: { width: 390, height: 844 } });
  networkTests('mobile 390px');
});
