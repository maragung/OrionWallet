import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalPrompt } from '../../src/connect/approval-ui/ApprovalPrompt';
import { previewTransfer } from '../../src/connect/typed-data';
import { importWalletFromSeed } from '../../src/wallet/wallet';

/**
 * What the transfer prompt puts in front of the user.
 *
 * The values here come from `previewTransfer`, the same function that resolves
 * what gets signed, so this doubles as a check that the prompt renders the
 * resolved numbers rather than the caller's raw request — a fee the site asked
 * for and a fee the wallet charges are not always the same string.
 */

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

// Real derived addresses: `previewTransfer` validates the recipient, so a
// placeholder string would fail before the prompt was ever built.
const FROM = importWalletFromSeed(new Uint8Array(32).fill(3)).addr;
const TO = importWalletFromSeed(new Uint8Array(32).fill(9)).addr;
const ORIGIN = 'https://dapp.example';

function render(detail: Record<string, unknown>): string {
  return decodeEntities(
    renderToStaticMarkup(
      <ApprovalPrompt
        request={{ kind: 'signTransfer', origin: ORIGIN, detail }}
        onDecision={() => undefined}
      />,
    ),
  );
}

/** The detail the handler builds: the request, plus the resolved preview. */
function detailFor(params: {
  to: string;
  amountRaw?: string;
  amount?: string;
  ou?: string;
  message?: string;
}) {
  return { ...params, ...previewTransfer(params, FROM), nonce: 5, opType: 'standard' };
}

describe('signTransfer approval summary', () => {
  it('leads with the amount and shows recipient, fee, and nonce', () => {
    const html = render(detailFor({ to: TO, amountRaw: '1500000' }));

    expect(html).toContain('Sign Transfer');
    expect(html).toContain('1.5 OCT');
    expect(html).toContain(TO);
    expect(html).toContain('To');
    expect(html).toContain('Fee');
    expect(html).toContain('Nonce');
    expect(html).toContain('>5<');
  });

  it('renders the fee the wallet resolved, not a blank when the site omitted one', () => {
    // A prompt that shows "—" for the fee is asking the user to approve a cost
    // it declined to name.
    const html = render(detailFor({ to: TO, amountRaw: '1000' }));
    expect(html).toContain('0.01 OCT'); // recommendedOu('standard', 1000) = 10000 raw
    expect(html).not.toContain('Fee</span><span class="mono">—');
  });

  it('shows a decimal request as the raw amount that will be signed', () => {
    const html = render(detailFor({ to: TO, amount: '0.25' }));
    expect(html).toContain('0.25 OCT');
  });

  it('renders a memo only when the site sent one', () => {
    const withMemo = render(detailFor({ to: TO, amountRaw: '1000', message: 'invoice 42' }));
    expect(withMemo).toContain('Memo');
    expect(withMemo).toContain('invoice 42');

    const without = render(detailFor({ to: TO, amountRaw: '1000' }));
    expect(without).not.toContain('Memo');
  });

  it('says the wallet will not send it, and names the site that asked', () => {
    const html = render(detailFor({ to: TO, amountRaw: '1000' }));
    // Sign-only is the security property the user is relying on; the prompt has
    // to state it rather than leave "Sign transfer" to be read as "send".
    expect(html).toContain('does not send it');
    expect(html).toContain(ORIGIN);
  });

  it('labels the confirm button as signing, and focuses reject instead', () => {
    const html = render(detailFor({ to: TO, amountRaw: '1000' }));
    expect(html).toContain('Sign transfer');
    expect(html).toContain('Reject');
    // The reject button comes first in the markup so a stray Enter cannot sign.
    expect(html.indexOf('Reject')).toBeLessThan(html.lastIndexOf('Sign transfer'));
  });

  it('offers the raw payload, collapsed rather than absent', () => {
    const html = render(detailFor({ to: TO, amountRaw: '1500000' }));
    expect(html).toContain('Show raw payload');
    expect(html).toContain('aria-expanded="false"');
  });
});

describe('signTransfer approval: raw payload', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reveals every field that will be signed when expanded', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    const detail = detailFor({ to: TO, amountRaw: '1500000', message: 'invoice 42' });
    await act(async () => {
      root.render(
        <ApprovalPrompt
          request={{ kind: 'signTransfer', origin: ORIGIN, detail }}
          onDecision={() => undefined}
        />,
      );
    });

    const toggle = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('raw payload'),
    );
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle!.click();
    });

    // The summary formats values for reading; the raw view is what lets a
    // careful user check the exact numbers the signature will cover.
    const text = container.textContent ?? '';
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    expect(text).toContain('1500000');
    expect(text).toContain('standard');
    expect(text).toContain('10000'); // resolved fee, raw
    expect(text).toContain('invoice 42');
    expect(text).toContain(TO);
  });
});
