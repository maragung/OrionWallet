import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAnchoredMenu, type AnchoredMenuOptions } from '../../src/hooks/useAnchoredMenu';

/**
 * Layout maths for the header dropdowns.
 *
 * These menus are laid out against the viewport because the header action row is
 * `overflow: hidden` on phones; an absolutely-positioned menu inside it was
 * clipped away entirely. Escaping the row means the clamping is now this hook's
 * job — a fixed layer is free to run off-screen if nobody stops it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ANCHOR = { top: 12, bottom: 44, left: 300, right: 380, width: 80, height: 32 };

let container: HTMLDivElement;
let root: Root;
let realRect: typeof Element.prototype.getBoundingClientRect;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

/** Mount the hook and report the style it produced. */
async function place(
  opts: AnchoredMenuOptions,
  anchor: Partial<typeof ANCHOR> = {},
): Promise<Record<string, unknown>> {
  const rect = { ...ANCHOR, ...anchor };
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { ...rect, x: rect.left, y: rect.top, toJSON: () => rect } as DOMRect;
  };

  let captured: Record<string, unknown> = {};
  function Probe() {
    const { anchorRef, style } = useAnchoredMenu<HTMLButtonElement>(true, opts);
    captured = style as Record<string, unknown>;
    return <button ref={anchorRef}>anchor</button>;
  }
  await act(async () => {
    root.render(<Probe />);
  });
  return captured;
}

describe('useAnchoredMenu', () => {
  beforeEach(() => {
    realRect = Element.prototype.getBoundingClientRect;
    setViewport(1280, 800);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    Element.prototype.getBoundingClientRect = realRect;
  });

  it('positions the menu in the viewport layer, below the trigger', async () => {
    const style = await place({ align: 'left', width: 260 });
    // `absolute` is what an ancestor with overflow:hidden clips; `fixed` is not.
    expect(style.position).toBe('fixed');
    expect(style.top).toBe(ANCHOR.bottom + 4);
    expect(style.left).toBe(ANCHOR.left);
    expect(style.width).toBe(260);
  });

  it('aligns a right-aligned menu to the trigger’s right edge', async () => {
    const style = await place({ align: 'right', width: 260 });
    expect(style.left).toBe(ANCHOR.right - 260);
  });

  it('keeps a right-aligned menu on screen when the trigger sits at the edge', async () => {
    setViewport(390, 844);
    const style = await place({ align: 'right', width: 260 }, { left: 330, right: 384, width: 54 });
    // Would have started at 124 and run 18px past the right edge.
    expect(style.left).toBe(390 - 260 - 8);
  });

  it('keeps a left-aligned menu on screen when the trigger sits at the left edge', async () => {
    setViewport(390, 844);
    const style = await place({ align: 'left', width: 260 }, { left: 4, right: 60, width: 56 });
    expect(style.left).toBe(8);
  });

  it('narrows the menu rather than overflowing a viewport smaller than it', async () => {
    setViewport(240, 600);
    const style = await place({ align: 'left', width: 280 }, { left: 10, right: 70, width: 60 });
    expect(style.width).toBe(240 - 16);
    expect(style.left).toBe(8);
  });

  it('caps the height at the space left below the trigger, and scrolls the rest', async () => {
    setViewport(390, 300);
    const style = await place({ align: 'left', width: 260, maxHeight: 380 });
    expect(style.maxHeight).toBe(300 - (ANCHOR.bottom + 4) - 8);
    expect(style.overflowY).toBe('auto');
  });

  it('never collapses to an unusable height on a very short viewport', async () => {
    setViewport(390, 120);
    const style = await place({ align: 'left', width: 260, maxHeight: 380 });
    expect(style.maxHeight).toBe(120);
  });

  it('stays hidden until it has been measured', async () => {
    let captured: Record<string, unknown> = {};
    function Probe() {
      const { style } = useAnchoredMenu<HTMLButtonElement>(false);
      captured = style as Record<string, unknown>;
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
    });
    // No anchor to measure yet: the menu must not paint at a guessed 0,0.
    expect(captured.visibility).toBe('hidden');
  });
});
