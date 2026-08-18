import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * useAnchoredMenu — put a dropdown in a top-level layer, positioned against the
 * viewport and anchored to its trigger, instead of absolutely positioning it
 * inside the trigger's parent.
 *
 * Two things kept the top-bar menus from working where they were:
 *
 *  - The action row is `overflow: hidden` at phone widths (a long account name
 *    has to truncate rather than push the row wider), and that clip applies to an
 *    `position: absolute` menu inside the row exactly as it does to text. The
 *    menus were in the DOM, laid out, even clickable from a script — and painted
 *    nowhere. Tapping the network pill on a phone appeared to do nothing at all.
 *  - `.app-header` is a stacking context of its own (`z-index: var(--z-header)`),
 *    so a menu inside it could not rise above anything outside it however large
 *    its own `z-index` was. A toast — `pointer-events: auto`, and positioned in
 *    the same top-right corner — covered the menu and swallowed the click that
 *    was meant for a menu row.
 *
 * So the menu renders through a portal (out of the header's stacking context) as
 * a fixed layer (out of the row's clip), and the position it lost by leaving its
 * parent is recomputed here from the trigger's own rect — also clamped to the
 * viewport, which matters most on the narrow screens this exists for.
 *
 * Because the menu is no longer a DOM descendant of the trigger, a
 * `wrapper.contains(event.target)` check would treat a click *on the menu* as a
 * click outside it. Dismissal therefore belongs to the hook: pass `onDismiss` and
 * it closes on an outside pointer-down or Escape, counting both the trigger and
 * the menu as inside.
 */
export interface AnchoredMenu<T extends HTMLElement> {
  /** Attach to the trigger the menu hangs from. */
  anchorRef: RefObject<T>;
  /** Attach to the menu itself, so outside-click detection can spare it. */
  menuRef: RefObject<HTMLDivElement>;
  /** Merge into the menu's own styles, last, so position and layer win. */
  style: CSSProperties;
  /** Wrap the menu element in this to render it in the top-level layer. */
  portal: (menu: ReactNode) => ReactNode;
}

export interface AnchoredMenuOptions {
  /** Which edge of the menu lines up with the trigger. Defaults to 'left'. */
  align?: 'left' | 'right';
  /** Preferred width in px; narrowed when the viewport cannot fit it. */
  width?: number;
  /** Hard cap on height; the visible cap is also limited by the space below. */
  maxHeight?: number;
  /** Gap between the trigger and the menu, in px. */
  gap?: number;
  /** Called on an outside pointer-down or Escape. Omit to handle dismissal yourself. */
  onDismiss?: () => void;
}

/** Distance kept between the menu and the edges of the viewport. */
const VIEWPORT_MARGIN = 8;

/** Above toasts, below modals — see the `--z-*` scale in styles/global.css. */
const MENU_LAYER = 'var(--z-dropdown, 1500)';

/**
 * Measure before paint, so the menu's first frame is already in the right place.
 * `window` is checked because this module is also imported where there is no DOM
 * (static rendering in tests), and a layout effect there is both useless and
 * noisy. Resolved once at module scope: the choice must not vary between renders.
 */
const useMeasure = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useAnchoredMenu<T extends HTMLElement>(
  open: boolean,
  opts: AnchoredMenuOptions = {},
): AnchoredMenu<T> {
  const { align = 'left', width = 260, maxHeight = 380, gap = 4, onDismiss } = opts;
  const anchorRef = useRef<T>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Hidden until measured: a menu painted at a stale position for one frame
  // reads as a visual jump, and the very first open has nothing to measure yet.
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    zIndex: MENU_LAYER,
    visibility: 'hidden',
  });

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const available = window.innerWidth - VIEWPORT_MARGIN * 2;
    const menuWidth = Math.min(width, available);
    const preferred = align === 'right' ? rect.right - menuWidth : rect.left;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, preferred),
      window.innerWidth - menuWidth - VIEWPORT_MARGIN,
    );
    const top = rect.bottom + gap;
    setStyle({
      position: 'fixed',
      zIndex: MENU_LAYER,
      top,
      left,
      width: menuWidth,
      maxHeight: Math.max(120, Math.min(maxHeight, window.innerHeight - top - VIEWPORT_MARGIN)),
      overflowY: 'auto',
    });
  }, [align, width, maxHeight, gap]);

  useMeasure(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    // `true` captures scrolling in any container, not just the window: the menu
    // is anchored to a fixed point in the viewport, so it has to follow.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open || !onDismiss) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (anchorRef.current?.contains(target) === true || menuRef.current?.contains(target) === true);
    const onPointerDown = (e: MouseEvent) => {
      if (!inside(e.target)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onDismiss]);

  const portal = useCallback(
    (menu: ReactNode) =>
      typeof document === 'undefined' ? menu : createPortal(menu, document.body),
    [],
  );

  return { anchorRef, menuRef, style, portal };
}
