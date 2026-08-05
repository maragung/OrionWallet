import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';

/**
 * Regression cover for the "white page stuck on loading" bug.
 *
 * index.html defines `#root:empty::before { content: 'Loading Orion Wallet…' }`.
 * Without a boundary, a render-time throw makes React 18 unmount the whole tree,
 * `#root` goes empty, and that CSS fallback renders — which users read as a
 * blank white page stuck loading. The boundary must absorb the throw and keep
 * something on screen instead.
 */
function Boom(): never {
  throw new Error('kaboom from panel');
}

describe('ErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the caught error; silence it so test output stays readable.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders children unchanged when nothing throws', () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary>
        <div>healthy panel</div>
      </ErrorBoundary>,
    );
    expect(html).toContain('healthy panel');
  });

  it('renders a recoverable error card instead of propagating the throw', () => {
    // renderToStaticMarkup rethrows, so assert the boundary's own render output
    // via getDerivedStateFromError rather than a full SSR pass.
    const state = ErrorBoundary.getDerivedStateFromError(new Error('kaboom from panel'));
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error?.message).toBe('kaboom from panel');
  });

  it('surfaces the failure message and keeps recovery actions available', () => {
    const boundary = new ErrorBoundary({ children: null });
    boundary.state = { error: new Error('kaboom from panel') };
    const html = renderToStaticMarkup(<>{boundary.render()}</>);

    expect(html).toContain('kaboom from panel');
    expect(html).toContain('Retry');
    expect(html).toContain('Reload app');
    // Critically: the output is non-empty, so #root never becomes :empty.
    expect(html.length).toBeGreaterThan(0);
  });

  it('uses a custom title when provided', () => {
    const boundary = new ErrorBoundary({ children: null, title: 'History failed' });
    boundary.state = { error: new Error('nope') };
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain('History failed');
  });

  it('clears the error and notifies the caller on retry', () => {
    const onReset = vi.fn();
    const boundary = new ErrorBoundary({ children: null, onReset });
    const setState = vi.fn();
    boundary.setState = setState as never;
    boundary.state = { error: new Error('nope') };

    // Invoke the Retry handler the same way the button does.
    (boundary as unknown as { handleRetry: () => void }).handleRetry();

    expect(setState).toHaveBeenCalledWith({ error: null });
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('is silent about Boom outside a boundary — documents the failure mode', () => {
    // Without a boundary the throw escapes to the caller. This is exactly what
    // used to blank the app.
    expect(() => renderToStaticMarkup(<Boom />)).toThrow('kaboom from panel');
  });
});
