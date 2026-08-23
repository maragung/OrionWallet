/**
 * Theme cookie — a synchronous, cross-document mirror of the effective theme.
 *
 * The canonical theme mode lives in IndexedDB settings, but IndexedDB cannot be
 * read synchronously at boot and is not shared with documents that render
 * before the wallet store loads (the /connect popup, the static demo page).
 * A plain cookie closes both gaps: main.tsx reads it before React mounts to
 * avoid a flash of the wrong theme, and any same-origin page can read it to
 * match the wallet's look.
 *
 * The value is always the *effective* theme ('dark' | 'light') — never the
 * 'system' mode — because consumers only need to know what to paint.
 */

export const THEME_COOKIE = 'orion_theme';

export type ThemeCookieValue = 'dark' | 'light';

/** Read the persisted theme cookie; null when absent or malformed. */
export function readThemeCookie(): ThemeCookieValue | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)orion_theme=(dark|light)(?:;|$)/);
  return match ? (match[1] as ThemeCookieValue) : null;
}

/** Persist the effective theme so the next document paints correctly first-try. */
export function writeThemeCookie(theme: ThemeCookieValue): void {
  if (typeof document === 'undefined') return;
  // Host-only cookie (no domain attribute) so it covers /connect, /docs and
  // /demo alike. One year, Lax: nothing here needs cross-site visibility.
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
}
