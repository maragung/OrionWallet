import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProcessingModal, type ProcessingStage } from '../../src/components/ProcessingModal';
import { ENCRYPT_STEPS, DECRYPT_STEPS } from '../../src/api/encrypt';
import { STEALTH_PREPARE_STEPS } from '../../src/stealth';
import type { StepDescriptor } from '../../src/utils/progress';

/** Decode the HTML entities that `renderToStaticMarkup` escapes (e.g. `&` → `&amp;`). */
function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

function render(stages: ProcessingStage[], props: Record<string, unknown> = {}): string {
  return decodeEntities(
    renderToStaticMarkup(<ProcessingModal open title="Processing" stages={stages} {...props} />),
  );
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
    expect(html).toContain('✓'); // done
    expect(html).toContain('✗'); // error
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
    expect(html).toContain('overflow-y:auto');
  });

  it('hides the step list and shows the summary once successful', () => {
    const html = decodeEntities(
      renderToStaticMarkup(
        <ProcessingModal
          open
          title="Encrypting Balance"
          stages={asPending(ENCRYPT_STEPS)}
          success
          successMessage="Encrypted 1.5 OCT"
        />,
      ),
    );
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
    const html = renderToStaticMarkup(
      <ProcessingModal open={false} title="T" stages={asPending(ENCRYPT_STEPS)} />,
    );
    expect(html).toBe('');
  });
});
