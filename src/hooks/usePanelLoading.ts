import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * usePanelLoading — panel-scoped loading state rendered as a dismissible modal.
 *
 * Replaces the global `setLoading` store action for per-panel work. The global
 * flag drives `LoadingOverlay`, a `position: fixed; inset: 0` blur that covers
 * the entire app for a single panel's fetch — and stays stuck forever if the
 * promise never settles.
 *
 * This hook instead keeps loading state local, so the panel's own content stays
 * on screen behind a small modal. Two safety properties:
 *
 *   - `isMounted` gating: state is never written after unmount, so navigating
 *     away mid-flight can't leave a modal hanging.
 *   - `hide()`: the user can dismiss the modal while the request continues in
 *     the background; its result is still applied if the panel is still mounted.
 *
 * The global overlay remains appropriate for whole-app transitions (wallet
 * unlock), which legitimately block everything.
 */
export interface PanelLoading {
  /** Whether the loading modal should be open. */
  loading: boolean;
  /** Title shown in the modal header. */
  title: string;
  /** Longer description shown in the modal body. */
  message: string | undefined;
  /** Open the modal imperatively. Pair with `hide()` in a `finally` block. */
  show: (title: string, message?: string) => void;
  /** Dismiss the modal without cancelling the in-flight work. */
  hide: () => void;
  /**
   * Run `fn` with the modal open, closing it when the work settles.
   * Errors propagate to the caller so existing try/catch logic keeps working.
   */
  run: <T>(title: string, fn: () => Promise<T>, message?: string) => Promise<T>;
  /** True while the component is still mounted; use to guard late setState. */
  isMounted: () => boolean;
}

export function usePanelLoading(): PanelLoading {
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState('Loading');
  const [message, setMessage] = useState<string | undefined>();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isMounted = useCallback(() => mounted.current, []);

  const show = useCallback((nextTitle: string, nextMessage?: string) => {
    setTitle(nextTitle);
    setMessage(nextMessage);
    setLoading(true);
  }, []);

  const hide = useCallback(() => setLoading(false), []);

  const run = useCallback(
    async <T>(nextTitle: string, fn: () => Promise<T>, nextMessage?: string): Promise<T> => {
      setTitle(nextTitle);
      setMessage(nextMessage);
      setLoading(true);
      try {
        return await fn();
      } finally {
        // Guard against unmount: React warns (and the state is pointless) if we
        // set it after the panel is gone.
        if (mounted.current) setLoading(false);
      }
    },
    [],
  );

  return { loading, title, message, show, hide, run, isMounted };
}
