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

const CONNECT_DRIVER = `
window.__wallet = (function () {
  let port = null;
  let nonce = 1;
  let ready = null;
  const pending = new Map();
  const events = [];
  function isEnv(x){return x&&typeof x==='object'&&typeof x.id==='string'&&(x.kind==='req'||x.kind==='res'||x.kind==='evt');}
  function onPort(e){
    const d = e.data;
    if(!isEnv(d)) return;
    if(d.kind==='res'){ const p=pending.get(d.id); if(p){pending.delete(d.id); d.error?p.reject(d.error):p.resolve(d.result);} }
    else if(d.kind==='evt'){ events.push({event:d.event,params:d.params}); }
  }
  function open(){
    ready = new Promise((resolve,reject)=>{
      const rid='rid_'+Math.random().toString(36).slice(2);
      const url = location.origin+'/connect?v=1&rid='+rid+'&origin='+encodeURIComponent(location.origin);
      const onHello=(ev)=>{
        if(ev.origin!==location.origin) return;
        const data=ev.data;
        if(!data||data.type!=='octra-wallet:hello'||data.rid!==rid) return;
        window.removeEventListener('message',onHello);
        port=ev.ports[0];
        port.onmessage=onPort;
        port.start&&port.start();
        port.postMessage({__ack:{challenge:data.challenge,dappNonce:'x',v:1,origin:location.origin}});
        resolve(true);
      };
      window.addEventListener('message',onHello);
      const w=window.open(url,'octra-wallet-connect','popup=yes,width=440,height=640');
      if(!w) reject(new Error('popup blocked'));
    });
    return true;
  }
  function whenReady(){ return ready; }
  function req(method,params){
    return new Promise((resolve,reject)=>{
      const id='req_'+(nonce)+'_'+Math.random().toString(36).slice(2);
      const env={v:1,id,kind:'req',method,params,nonce:nonce++,ts:Date.now()};
      pending.set(id,{resolve,reject});
      port.postMessage(env);
    });
  }
  return { open, whenReady, req, events };
})();
`;

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
  await page.addScriptTag({ content: CONNECT_DRIVER });
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
});
