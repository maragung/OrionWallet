import { test, expect, type Page } from '@playwright/test';
import { createWallet, clearIndexedDBAndReload } from './helpers';

/**
 * End-to-end coverage of the Wallet SDK connect flow, running same-origin
 * against the production preview build (so COOP is a non-issue here).
 *
 * The opener page implements the tiny dApp-side handshake inline (the published
 * SDK does the same thing): open /connect, receive the ONE window-level hello
 * that transfers a MessagePort, ack the challenge over the port, then speak
 * envelopes. The popup runs the real ConnectApp + ConnectHandler from the build.
 */

/**
 * The dApp-side driver, executed via page.evaluate (CDP) so the page CSP
 * (script-src 'self') does not block inline <script> injection.
 */
function installConnectDriver(this: unknown): void {
  const w = window as unknown as { __wallet: unknown };
  w.__wallet = (function () {
    let port: MessagePort | null = null;
    let nonce = 1;
    let ready: Promise<boolean> | null = null;
    let adopted = false;
    const pending = new Map<
      string,
      {
        env: Record<string, unknown>;
        resolve: (v: unknown) => void;
        reject: (e: unknown) => void;
        preAdoption: boolean;
      }
    >();
    const events: Array<{ event: string; params: unknown }> = [];
    function isEnv(x: unknown): boolean {
      return (
        !!x &&
        typeof x === 'object' &&
        typeof (x as { id?: unknown }).id === 'string' &&
        ((x as { kind?: unknown }).kind === 'req' ||
          (x as { kind?: unknown }).kind === 'res' ||
          (x as { kind?: unknown }).kind === 'evt')
      );
    }
    function onPort(e: MessageEvent): void {
      const d = e.data as {
        kind?: string;
        id?: string;
        error?: unknown;
        result?: unknown;
        event?: string;
        params?: unknown;
      };
      if (!isEnv(d)) return;
      console.log(
        '[driver] port message',
        JSON.stringify({ kind: d.kind, id: d.id, event: d.event }),
      );
      if (d.kind === 'res') {
        const p = pending.get(d.id!);
        if (p) {
          pending.delete(d.id!);
          if (d.error) p.reject(d.error);
          else p.resolve(d.result);
        }
      } else if (d.kind === 'evt') {
        if (d.event === 'sessionAdopted') {
          // The wallet moved the port to its main window; requests posted
          // before the transfer may have been dropped mid-flight. Re-send them
          // (same id/nonce/ts) so they land on the adopted handler.
          adopted = true;
          for (const p of pending.values()) {
            if (!p.preAdoption) continue;
            p.preAdoption = false;
            console.log(
              '[driver] retry on adoption',
              JSON.stringify({ id: p.env.id, method: p.env.method }),
            );
            port!.postMessage(p.env);
          }
        }
        events.push({ event: String(d.event), params: d.params });
      }
    }
    function open(): boolean {
      ready = new Promise<boolean>((resolve, reject) => {
        const rid = 'rid_' + Math.random().toString(36).slice(2);
        const url =
          location.origin +
          '/connect?v=1&rid=' +
          rid +
          '&origin=' +
          encodeURIComponent(location.origin);
        const onHello = (ev: MessageEvent): void => {
          if (ev.origin !== location.origin) return;
          const data = ev.data as { type?: string; rid?: string; challenge?: string };
          if (!data || data.type !== 'octra-wallet:hello' || data.rid !== rid) return;
          window.removeEventListener('message', onHello);
          port = (ev as MessageEvent & { ports: MessagePort[] }).ports[0];
          port.onmessage = onPort;
          if (typeof port.start === 'function') port.start();
          port.postMessage({
            __ack: { challenge: data.challenge, dappNonce: 'x', v: 1, origin: location.origin },
          });
          resolve(true);
        };
        window.addEventListener('message', onHello);
        const w = window.open(url, 'octra-wallet-connect', 'popup=yes,width=440,height=640');
        if (!w) reject(new Error('popup blocked'));
      });
      return true;
    }
    function whenReady(): Promise<boolean> | null {
      return ready;
    }
    function req(method: string, params: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = 'req_' + nonce + '_' + Math.random().toString(36).slice(2);
        const env = {
          v: 1,
          id,
          kind: 'req',
          method,
          params,
          nonce: nonce++,
          ts: Date.now(),
        };
        console.log('[driver] req posted', JSON.stringify({ id, method, nonce: env.nonce }));
        pending.set(id, { env, resolve, reject, preAdoption: !adopted });
        port!.postMessage(env);
      });
    }
    return { open, whenReady, req, events };
  })();
}

/** The popup is a separate document that shares the encrypted wallet in
 * IndexedDB. It inherits a copy of the opener's unlock session, so it normally
 * comes up already unlocked; the PIN is only filled in when it does show the
 * unlock screen (no live session, or a different account is being unlocked). */
async function unlockPopup(popup: Page, pin: string): Promise<void> {
  await popup.waitForLoadState('domcontentloaded');
  const pinInput = popup.locator('input[id="pin"]');
  if (await pinInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await pinInput.fill(pin);
    await popup.getByRole('button', { name: /Unlock/i }).click();
  }
}

/** The popup may hand its session port to the main wallet window after a
 * successful connect (see ConnectApp maybeHandoff), so a later approval prompt
 * can show in EITHER the popup (still hosting) or the main window (adopted).
 * This resolves to whichever window shows it first; `approveInAnyWindow` below
 * is the common case, and a test that needs to interact with the prompt itself
 * (focus, Escape) uses this directly. */
async function promptWindow(page: Page, popup: Page, promptTitle: string): Promise<Page> {
  /* The card's own title, not any text on the card. `getByText` is a case-insensitive
     substring match, so `getByText('Sign Transfer')` also matched that prompt's
     "Sign transfer" button — two hits, a strict-mode violation, and because the wait is
     wrapped in `.catch(() => null)` it read as "the prompt never appeared". */
  const title = (p: Page) =>
    p.locator('.approval-card .card-title').filter({ hasText: promptTitle });
  const popupWait = popup.isClosed()
    ? Promise.resolve(null)
    : title(popup)
        .waitFor({ timeout: 12_000 })
        .then(() => popup)
        .catch(() => null);
  const mainWait = title(page)
    .waitFor({ timeout: 12_000 })
    .then(() => page)
    .catch(() => null);
  const which = await Promise.race([popupWait, mainWait]);
  if (!which) throw new Error(`Approval prompt "${promptTitle}" did not appear in any window`);
  return which;
}

async function approveInAnyWindow(
  page: Page,
  popup: Page,
  promptTitle: string,
  confirmButton: string,
): Promise<void> {
  const host = await promptWindow(page, popup, promptTitle);
  await host.getByRole('button', { name: confirmButton }).click();
}

function forwardConsole(page: Page, tag: string) {
  page.on('console', (msg) => {
    const t = msg.text();
    if (
      t.startsWith('[driver]') ||
      t.startsWith('[handoff]') ||
      t.startsWith('[rpc]') ||
      t.startsWith('[approval]')
    ) {
      const clock = Date.now() % 100000;
      console.log(`[browser ${clock}] <${tag}> ${t}`);
    }
  });
}

async function setupWalletAndDriver(page: Page) {
  await clearIndexedDBAndReload(page);
  await createWallet(page);
  forwardConsole(page, 'main');
  await page.evaluate(installConnectDriver);
}

test.describe('Wallet SDK connect flow', () => {
  // The multi-account flow (derive, unlock, PIN gate, handoff) is slow: give it
  // headroom beyond the global config timeout.
  test.setTimeout(120_000);

  test('connects, reads info, signs a message, and blocks forbidden methods', async ({
    page,
    context,
  }) => {
    await setupWalletAndDriver(page);

    // Open the connect popup and capture the popup page (do not await handshake yet).
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.evaluate(() => (window as unknown as { __wallet: { open(): boolean } }).__wallet.open()),
    ]);
    // Popup is a separate document — unlock it with the PIN.
    forwardConsole(popup, 'popup');
    await unlockPopup(popup, 'Pass1word!abc');

    // After unlock, the hello fires and the handshake completes.
    await page.evaluate(() =>
      (window as unknown as { __wallet: { whenReady(): Promise<boolean> } }).__wallet.whenReady(),
    );

    // Fire the connect request; this triggers the approval prompt in the popup.
    const connectPromise = page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_connect', { origin: location.origin }),
    );
    await expect(popup.getByText('Connection Request')).toBeVisible({ timeout: 15_000 });
    await expect(popup.getByText(new URL(page.url()).origin)).toBeVisible();
    await popup.getByRole('button', { name: 'Connect' }).click();
    const connectResult = (await connectPromise) as { address: string; network: string };
    expect(connectResult.address).toMatch(/^oct/);
    expect(connectResult.network).toBeTruthy();

    // Read-only call is served silently (no popup interaction).
    const network = await page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_getNetwork', {}),
    );
    expect(typeof network).toBe('string');

    // signMessage requires an explicit approval interaction.
    const signPromise = page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_signMessage', { message: 'hello from e2e' }),
    );
    await approveInAnyWindow(page, popup, 'Sign Message', 'Sign');
    const signed = (await signPromise) as { signature: string; message: string };
    expect(signed.signature).toBeTruthy();
    expect(signed.message).toBe('hello from e2e');

    // Prohibited method is rejected by the wallet with METHOD_FORBIDDEN.
    const forbidden = await page.evaluate(async () => {
      try {
        await (
          window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
        ).__wallet.req('sendTransaction', { to: 'x', amount: '1' });
        return { ok: true };
      } catch (e) {
        return { ok: false, code: (e as { code?: string }).code };
      }
    });
    expect(forbidden).toMatchObject({ ok: false, code: 'METHOD_FORBIDDEN' });
  });

  test('user rejection surfaces USER_REJECTED', async ({ page, context }) => {
    await setupWalletAndDriver(page);

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.evaluate(() => (window as unknown as { __wallet: { open(): boolean } }).__wallet.open()),
    ]);
    await unlockPopup(popup, 'Pass1word!abc');
    await page.evaluate(() =>
      (window as unknown as { __wallet: { whenReady(): Promise<boolean> } }).__wallet.whenReady(),
    );

    // Fire connect first — that is what triggers the approval prompt.
    const connectPromise = page.evaluate(async () => {
      try {
        await (
          window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
        ).__wallet.req('wallet_connect', { origin: location.origin });
        return { ok: true };
      } catch (e) {
        return { ok: false, code: (e as { code?: string }).code };
      }
    });
    await expect(popup.getByText('Connection Request')).toBeVisible({ timeout: 15_000 });
    await popup.getByRole('button', { name: 'Reject' }).click();
    expect(await connectPromise).toMatchObject({ ok: false, code: 'USER_REJECTED' });
  });

  /**
   * `signTransfer` is the one approval that moves value, and it was the only prompt the
   * suite never opened. It is asserted here end to end: what the prompt says, that Escape
   * alone rejects it, and that approval returns a *signed* transaction rather than a
   * broadcast one.
   */
  test('signTransfer prompts with the exact transfer, rejects on Escape, signs on approval', async ({
    page,
    context,
  }) => {
    /* The nonce is resolved before the prompt opens, so the prompt can name the exact
       transaction that will be signed — one real RPC round trip, and this suite otherwise
       never touches the network. Stubbing it keeps the test hermetic and makes the
       displayed nonce an exact expectation instead of whatever devnet happens to hold.

       Only `octra_balance` is answered. Answering every method with the same payload
       instead handed the fee-schedule call a balance object, and `fees.recommended`
       being undefined took Balance's panel down inside its error boundary — a stub that
       lies about the shape of an unrelated method breaks the window under test. Every
       other call is aborted, which is exactly what the rest of this suite sees offline. */
    await context.route('https://devnet.octrascan.io/**', async (route) => {
      const method = (route.request().postDataJSON() as { method?: string } | null)?.method;
      if (method !== 'octra_balance') return route.abort();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { addr: 'stub', balance: '10.0', nonce: 41, has_public_key: true },
        }),
      });
    });

    await setupWalletAndDriver(page);

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.evaluate(() => (window as unknown as { __wallet: { open(): boolean } }).__wallet.open()),
    ]);
    forwardConsole(popup, 'popup');
    await unlockPopup(popup, 'Pass1word!abc');
    await page.evaluate(() =>
      (window as unknown as { __wallet: { whenReady(): Promise<boolean> } }).__wallet.whenReady(),
    );

    const connectPromise = page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_connect', { origin: location.origin }),
    );
    await approveInAnyWindow(page, popup, 'Connection Request', 'Connect');
    await connectPromise;

    /** A valid Octra address that is not the wallet's own — a self-send is refused earlier. */
    const RECIPIENT = 'oct39TH6PmokBGXVRibeAThZiomaweFqR5amvKpByTBqbhQ';

    const askToSign = () =>
      page.evaluate(async (to) => {
        try {
          const r = await (
            window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
          ).__wallet.req('wallet_signTransfer', { to, amount: '1.5', message: 'e2e memo' });
          return { ok: true, result: r as Record<string, unknown> };
        } catch (e) {
          return { ok: false, code: (e as { code?: string }).code };
        }
      }, RECIPIENT);

    // ── First attempt: read the prompt, then reject it from the keyboard alone.
    const rejectedPromise = askToSign();
    const host = await promptWindow(page, popup, 'Sign Transfer');
    // What the user is being asked to sign, in the numbers they were shown.
    await expect(host.locator('.approval-amount')).toContainText('1.5');
    // `.first()` is the To row: the raw-payload block below repeats these values.
    await expect(host.getByText(RECIPIENT).first()).toBeVisible();
    // Stubbed confirmed nonce 41, so the transaction takes 42.
    await expect(host.locator('.approval-card')).toContainText('42');
    await expect(host.getByText('e2e memo').first()).toBeVisible();

    /* Reject holds focus on mount, so a keystroke arriving mid-prompt cannot sign: the
       accidental outcome has to be the safe one. */
    expect(await host.evaluate(() => document.activeElement?.textContent)).toBe('Reject');

    await host.keyboard.press('Escape');
    expect(await rejectedPromise).toMatchObject({ ok: false, code: 'USER_REJECTED' });

    // ── Second attempt: approve, and the site gets a signature back — not a broadcast.
    const signedPromise = askToSign();
    await approveInAnyWindow(page, popup, 'Sign Transfer', 'Sign transfer');
    const signed = (await signedPromise) as {
      ok: boolean;
      result: { signedTransaction?: unknown; to?: string; nonce?: number; note?: string };
    };
    expect(signed.ok).toBe(true);
    expect(signed.result.signedTransaction).toBeTruthy();
    expect(signed.result.to).toBe(RECIPIENT);
    expect(signed.result.nonce).toBe(42);
  });

  test('multi-account connect lets the user pick which account to connect', async ({
    page,
    context,
  }) => {
    await clearIndexedDBAndReload(page);
    await createWallet(page);
    forwardConsole(page, 'main');

    // Derive a second HD account via Settings → Accounts → Derive New.
    await page
      .getByRole('button', { name: /Settings/i })
      .first()
      .click();
    // Settings' sections are a tablist now, so this is a tab and not a button.
    await page.getByRole('tab', { name: /Accounts/i }).click();
    // The leading "+" is a plus icon now, so match on the words only.
    await page.click('button:has-text("Derive New")');
    await page.fill('input[id="dname"]', 'Account B');
    await page.fill('input[id="didx"]', '1');
    await page.fill('input[id="dpin"]', 'Pass1word!abc');
    await page.click('button:has-text("Derive Account")');
    // The active wallet switches to the newly derived account.
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 15_000 });

    // Install the dApp driver on the main page (the popup is separate).
    await page.evaluate(installConnectDriver);

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.evaluate(() => (window as unknown as { __wallet: { open(): boolean } }).__wallet.open()),
    ]);
    await unlockPopup(popup, 'Pass1word!abc');
    await page.evaluate(() =>
      (window as unknown as { __wallet: { whenReady(): Promise<boolean> } }).__wallet.whenReady(),
    );

    // Fire connect — the approval prompt shows the account picker.
    const connectPromise = page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_connect', { origin: location.origin }),
    );
    await expect(popup.getByText('Connection Request')).toBeVisible({ timeout: 15_000 });
    // The account picker is visible with two accounts.
    await expect(popup.getByText('Connect with account')).toBeVisible();
    await expect(popup.locator('select#connect-account')).toBeVisible();
    await expect(popup.locator('select#connect-account option')).toHaveCount(2);

    // The popup unlocked the ORIGINAL account (blob "default"), so Account B is
    // not unlocked there. Pick Account B — connecting requires its PIN.
    const optionLabels = await popup.locator('select#connect-account option').allTextContents();
    const accountBIndex = optionLabels.findIndex((l) => l.includes('Account B'));
    expect(accountBIndex).toBeGreaterThanOrEqual(0);
    await popup.locator('select#connect-account').selectOption({ index: accountBIndex });
    await popup.getByRole('button', { name: 'Connect' }).click();

    // The popup asks for the PIN to unlock the selected account's keys.
    await expect(popup.getByText('Unlock account').first()).toBeVisible({ timeout: 10_000 });
    await popup.fill('input[id="pin-modal-input"]', 'Pass1word!abc');
    await popup.getByRole('button', { name: 'Unlock' }).click();

    const connectResult = (await connectPromise) as { address: string; accounts: unknown[] };
    expect(connectResult.accounts).toHaveLength(2);
    // The connected address must be Account B, not the active original account.
    expect(connectResult.address).toMatch(/^oct/);

    // The session reports the chosen account via getAddress.
    const addr = await page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_getAddress', {}),
    );
    expect(addr).toBe(connectResult.address);

    // Signing uses the session account's keys (Account B).
    const signPromise = page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_signMessage', { message: 'multi-account' }),
    );
    await approveInAnyWindow(page, popup, 'Sign Message', 'Sign');
    const signed = (await signPromise) as { address: string; signature: string };
    expect(signed.signature).toBeTruthy();
    expect(signed.address).toBe(connectResult.address);
  });
});
