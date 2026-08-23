import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProcessingModal, type ProcessingStage } from '../../src/components/ProcessingModal';
import { ENCRYPT_STEPS, DECRYPT_STEPS } from '../../src/api/encrypt';
import { STEALTH_PREPARE_STEPS } from '../../src/stealth';
import type { StepDescriptor } from '../../src/utils/progress';

/** React 18 wants this flag before `act` is used. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** jsdom has no layout engine, so elements have no scrolling methods to call. */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * The modal renders through a portal into document.body (so it escapes
 * `.app-header`'s stacking context in the app), so the markup is read back from
 * the whole body rather than the mount node.
 */
function render(stages: ProcessingStage[], props: Record<string, unknown> = {}): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<ProcessingModal open title="Processing" stages={stages} {...props} />);
  });
  const html = document.body.innerHTML;
  act(() => root.unmount());
  host.remove();
  return decodeEntities(html);
}

/** Decode the HTML entities that serialization escapes (e.g. `&` → `&amp;`). */
function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

const asPending = (steps: StepDescriptor[]): ProcessingStage[] =>
  steps.map((s) => ({ ...s, status: 'pending' as const }));

describe('ProcessingModal step rendering', () => {
  it('renders every encrypt step label and description', () => {
    const html = render(asPending(ENCRYPT_STEPS));
    for (const s of ENCRYPT_STEPS) {
      expect(html).toContain(s.label);
      expect(html).toContain(s.description!);
    }
  });

  it('renders every decrypt step, including the extra proof stages', () => {
    const html = render(asPending(DECRYPT_STEPS));
    expect(DECRYPT_STEPS.length).toBeGreaterThan(ENCRYPT_STEPS.length);
    for (const s of DECRYPT_STEPS) {
      expect(html).toContain(s.label);
      expect(html).toContain(s.description!);
    }
  });

  it('renders every stealth key-derivation step', () => {
    const html = render(asPending(STEALTH_PREPARE_STEPS));
    for (const s of STEALTH_PREPARE_STEPS) {
      expect(html).toContain(s.label);
    }
  });

  it('numbers pending steps and marks done/error steps with glyphs', () => {
    const html = render([
      { id: 'a', label: 'Alpha', status: 'done', description: 'completed detail' },
      { id: 'b', label: 'Beta', status: 'active', description: 'in flight' },
      { id: 'c', label: 'Gamma', status: 'error', description: 'failure detail' },
      { id: 'd', label: 'Delta', status: 'pending' },
    ]);
    // The done/error marks are icons from the wallet's own set, and each <svg>
    // carries the name it was drawn from — an inline <path> is not identifiable.
    expect(html).toContain('data-icon="check"'); // done
    expect(html).toContain('data-icon="x"'); // error
    expect(html).toContain('completed detail');
    expect(html).toContain('failure detail');
    expect(html).toContain('>4<'); // pending step keeps its index
  });

  it('shows a spinner on the active step only', () => {
    const html = render([
      { id: 'a', label: 'Alpha', status: 'done' },
      { id: 'b', label: 'Beta', status: 'active' },
    ]);
    // One inline step spinner plus the header spinner.
    expect(html.match(/class="spinner"/g) ?? []).toHaveLength(1);
  });

  it('makes a long step list scrollable so all steps stay reachable', () => {
    const html = render(asPending(DECRYPT_STEPS));
    // The scrolling container is `.step-list`; the overflow itself now lives in
    // the stylesheet, which jsdom does not load, so the class is what is checkable
    // here. Its rendered height is asserted in the Playwright suite instead.
    expect(html).toContain('class="step-list"');
  });

  it('hides the step list and shows the summary once successful', () => {
    const html = render(asPending(ENCRYPT_STEPS), {
      title: 'Encrypting Balance',
      success: true,
      successMessage: 'Encrypted 1.5 OCT',
    });
    expect(html).toContain('Encrypted 1.5 OCT');
    expect(html).toContain('Success');
    expect(html).not.toContain('Initializing PVAC module');
  });

  it('surfaces the error message and keeps the step list visible', () => {
    const stages = asPending(ENCRYPT_STEPS);
    stages[0] = { ...stages[0]!, status: 'error', description: 'PVAC WASM module is not loaded' };
    const html = render(stages, { error: 'PVAC init failed' });
    expect(html).toContain('PVAC init failed');
    expect(html).toContain('PVAC WASM module is not loaded');
    expect(html).toContain('Error');
  });

  it('renders nothing when closed', () => {
    const html = render(asPending(ENCRYPT_STEPS), { open: false, title: 'T' });
    expect(html).not.toContain('class="modal-overlay"');
    expect(html).not.toContain('>T<');
  });
});
