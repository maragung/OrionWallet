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
    const pending = new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: unknown) => void }
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
      if (d.kind === 'res') {
        const p = pending.get(d.id!);
        if (p) {
          pending.delete(d.id!);
          if (d.error) p.reject(d.error);
          else p.resolve(d.result);
        }
      } else if (d.kind === 'evt') {
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
        pending.set(id, { resolve, reject });
        port!.postMessage(env);
      });
    }
    return { open, whenReady, req, events };
  })();
}

/** The popup is a separate document: it shares the encrypted wallet in
 * IndexedDB but NOT the in-memory unlocked state, so it must be unlocked with
 * the PIN before it can send the hello. */
async function unlockPopup(popup: Page, pin: string): Promise<void> {
  await popup.waitForLoadState('domcontentloaded');
  const pinInput = popup.locator('input[id="pin"]');
  if (await pinInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await pinInput.fill(pin);
    await popup.getByRole('button', { name: /Unlock/i }).click();
  }
}

async function setupWalletAndDriver(page: Page) {
  await clearIndexedDBAndReload(page);
  await createWallet(page);
  await page.evaluate(installConnectDriver);
}

test.describe('Wallet SDK connect flow', () => {
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

    // signMessage requires an explicit approval popup interaction.
    const signPromise = page.evaluate(() =>
      (
        window as unknown as { __wallet: { req(m: string, p: unknown): Promise<unknown> } }
      ).__wallet.req('wallet_signMessage', { message: 'hello from e2e' }),
    );
    await expect(popup.getByText('Sign Message')).toBeVisible({ timeout: 10_000 });
    await popup.getByRole('button', { name: 'Sign' }).click();
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

  test('multi-account connect lets the user pick which account to connect', async ({
    page,
    context,
  }) => {
    await clearIndexedDBAndReload(page);
    await createWallet(page);

    // Derive a second HD account via Settings → Accounts → Derive New.
    await page
      .getByRole('button', { name: /Settings/i })
      .first()
      .click();
    await page.getByRole('button', { name: /Accounts/i }).click();
    await page.click('button:has-text("+ Derive New")');
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
    await expect(popup.getByRole('radio', { name: /Account B/ })).toBeVisible();

    // The popup unlocked the ORIGINAL account (blob "default"), so Account B is
    // not unlocked there. Pick Account B — connecting requires its PIN.
    await popup.getByRole('radio', { name: /Account B/ }).check();
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
    await expect(popup.getByText('Sign Message')).toBeVisible({ timeout: 10_000 });
    await popup.getByRole('button', { name: 'Sign' }).click();
    const signed = (await signPromise) as { address: string; signature: string };
    expect(signed.signature).toBeTruthy();
    expect(signed.address).toBe(connectResult.address);
  });
});
