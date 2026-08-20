/**
 * The single source of truth for the browser-chrome colour of each theme.
 *
 * `<meta name="theme-color">` tints the iOS/Android browser UI, and it has to match
 * `--surface-0` in `global.css` or the status bar sits a shade off the page it frames.
 * The value used to be hardcoded in three places — `index.html`, `src/main.tsx`, and
 * `src/hooks/useTheme.ts` — which meant a palette change silently left the mobile chrome
 * on the old colour. Both TS call sites now read it from here.
 *
 * `index.html` still needs literals (it is parsed before any module runs, and the
 * pre-paint background is what prevents a white flash on a dark theme), so the two
 * literals there carry a comment pointing back at this file.
 */
export const THEME_COLORS = {
  /** Matches `--surface-0` in the default `:root` block. */
  dark: '#0b0d12',
  /** Matches `--surface-0` in the `[data-theme='light']` block. */
  light: '#f7f8fa',
} as const;

export type ThemeColorKey = keyof typeof THEME_COLORS;

/** Point `<meta name="theme-color">` at the given theme. No-op outside a document. */
export function applyThemeColorMeta(theme: ThemeColorKey): void {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
}
