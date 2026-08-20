/**
 * The wallet's icon set — local, monochrome, stroke-based SVG.
 *
 * WHY NOT EMOJI. The UI used to draw 159 emoji glyphs across 31 components. Emoji are
 * rendered by the OS font, so the same screen looked different on every platform (Apple's
 * glossy 3D set, Windows' flat Segoe set, DejaVu's monochrome fallback on Linux, and a
 * literal ▯ where a glyph is missing). They also cannot inherit `currentColor`, so an emoji
 * inside a muted label stayed full-colour, and they sit off the text baseline at small sizes.
 *
 * These icons are drawn on a 24×24 grid with `fill: none` and `stroke: currentColor`, so
 * every one of them takes the colour of the text around it — an icon in a `.muted` row is
 * muted, an icon on the gradient hero is white — with no per-icon styling.
 *
 * ADDING AN ICON: add one entry to `ICON_PATHS`. Keep the artwork inside the 24×24 box with
 * ~2px of visual padding, use round caps/joins, and describe shapes with paths rather than
 * `fill`, so `strokeWidth` stays the single lever for weight.
 *
 * Four glyph families deliberately survive as text, so a future sweep does not "finish
 * the job" by removing them:
 *   - box-drawing characters (─ ═) in source comments, which are not UI at all;
 *   - the country flags in `src/i18n/types.ts`, which identify 20 languages. A flag is
 *     inherently multicolour and carries no stroke silhouette, so a monochrome outline
 *     version would be unrecognisable;
 *   - `NetworkDef.icon` ('🧪', '🚀', '🌐'), which is persisted user data in IndexedDB, not
 *     markup. Changing the stored value would break every wallet already on disk, so
 *     `network-icon.ts` maps the stored glyph to a local icon at render time instead;
 *   - the bell in `connect/attention.ts`, which goes into `document.title`. That string is
 *     drawn by the OS in the tab strip and the taskbar, where an inline SVG cannot reach.
 * Arrows inside prose ("Settings → Network", "Public → Encrypted") also stay as text: there
 * they are punctuation, not an icon, and an inline SVG would break the sentence's line-wrap.
 */
import type { CSSProperties, SVGProps } from 'react';

/** Path/shape data per icon, as JSX children of the shared `<svg>` wrapper. */
const ICON_PATHS = {
  // ── Wallet navigation ──
  home: (
    <path d="M3 10.2 12 3l9 7.2V20a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 20v-9.8Z M9.3 21.5V14h5.4v7.5" />
  ),
  send: <path d="M7 17 17 7 M8.2 7H17v8.8" />,
  receive: <path d="M17 7 7 17 M15.8 17H7V8.2" />,
  history: (
    <>
      <path d="M3.2 12A8.8 8.8 0 1 0 12 3.2a9.5 9.5 0 0 0-6.6 2.7L3 8.3" />
      <path d="M3 3.4v5h5" />
      <path d="M12 7.6V12l3.6 2.1" />
    </>
  ),
  gem: <path d="M6 3h12l3.6 6L12 21 2.4 9 6 3Z M2.4 9h19.2 M6 3l3.6 6L12 21l2.4-12L18 3" />,
  wallet: (
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h11a2 2 0 0 1 2 2" />
      <rect x="3.5" y="7.5" width="17" height="11.5" rx="2" />
      <path d="M16 13.2h1.6" />
    </>
  ),

  // ── Privacy ──
  'shield-lock': (
    <>
      <path d="M12 21.4c4.7-1.9 7.4-5.3 7.4-9.4V5.6L12 2.6 4.6 5.6v6.4c0 4.1 2.7 7.5 7.4 9.4Z" />
      <rect x="9.4" y="11.4" width="5.2" height="4.4" rx="1" />
      <path d="M10.4 11.4v-1.3a1.6 1.6 0 0 1 3.2 0v1.3" />
    </>
  ),
  ghost: (
    <>
      <path d="M12 2.6a7.6 7.6 0 0 0-7.6 7.6v11.2l2.9-2.9 2.4 2.4L12 18.6l2.3 2.3 2.4-2.4 2.9 2.9V10.2A7.6 7.6 0 0 0 12 2.6Z" />
      <path d="M9.4 10.4h.01 M14.6 10.4h.01" />
    </>
  ),
  shield: (
    <path d="M12 21.4c4.7-1.9 7.4-5.3 7.4-9.4V5.6L12 2.6 4.6 5.6v6.4c0 4.1 2.7 7.5 7.4 9.4Z" />
  ),
  'shield-check': (
    <>
      <path d="M12 21.4c4.7-1.9 7.4-5.3 7.4-9.4V5.6L12 2.6 4.6 5.6v6.4c0 4.1 2.7 7.5 7.4 9.4Z" />
      <path d="M9 11.8l2.2 2.2 4-4.2" />
    </>
  ),

  // ── Contracts / tools ──
  'file-text': (
    <>
      <path d="M14.2 2.6H7A2 2 0 0 0 5 4.6v14.8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.4l-4.8-4.8Z" />
      <path d="M14.2 2.6v4.8H19" />
      <path d="M8.4 12.6h7.2 M8.4 16.2h4.8 M8.4 9h2.4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.6" />
      <path d="m15.6 15.6 4.6 4.6" />
    </>
  ),
  'app-window': (
    <>
      <rect x="2.6" y="4.2" width="18.8" height="15.6" rx="2.2" />
      <path d="M2.6 9h18.8" />
      <path d="M6 6.6h.01 M9 6.6h.01" />
    </>
  ),
  'circle-dot': (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.5 14.4a1.5 1.5 0 0 0 .3 1.65l.06.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.17a1.8 1.8 0 1 1-3.6 0v-.09a1.5 1.5 0 0 0-.99-1.37 1.5 1.5 0 0 0-1.65.3l-.06.06a1.8 1.8 0 1 1-2.55-2.55l.06-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H4.2a1.8 1.8 0 1 1 0-3.6h.09a1.5 1.5 0 0 0 1.37-.99 1.5 1.5 0 0 0-.3-1.65l-.06-.06A1.8 1.8 0 1 1 7.85 4.6l.06.06a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V3.4a1.8 1.8 0 1 1 3.6 0v.09a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.06a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.17a1.8 1.8 0 1 1 0 3.6h-.09a1.5 1.5 0 0 0-1.37.9Z" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
  ),
  'book-open': (
    <>
      <path d="M12 6.4v13.4" />
      <path d="M12 6.4C10.6 5 8.8 4.3 6.6 4.3H3.4v13h3.2c2.2 0 4 .7 5.4 2.1 1.4-1.4 3.2-2.1 5.4-2.1h3.2v-13h-3.2c-2.2 0-4 .7-5.4 2.1Z" />
    </>
  ),
  signature: (
    <>
      <path d="M4 16.4c2.4 0 3.7-1.4 3.7-4.2 0-2.2-.8-3.4-2-3.4-1 0-1.7 1-1.7 2.3 0 3 3 5.3 6.9 5.3 3.4 0 6-1.3 7.6-4" />
      <path d="M4 20.4h16" />
    </>
  ),

  // ── Security ──
  lock: (
    <>
      <rect x="4.4" y="10.4" width="15.2" height="11" rx="2.2" />
      <path d="M7.8 10.4V7.2a4.2 4.2 0 0 1 8.4 0v3.2" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.4" y="10.4" width="15.2" height="11" rx="2.2" />
      <path d="M7.8 10.4V7.2a4.2 4.2 0 0 1 8.1-1.4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="16" r="4" />
      <path d="m10.9 13.1 8.7-8.7 M17.4 6.6l2.2 2.2 M14.9 9.1l2.2 2.2" />
    </>
  ),
  fingerprint: (
    <>
      <path d="M4.6 12a7.4 7.4 0 0 1 14.8 0" />
      <path d="M7.6 13.4a4.4 4.4 0 0 1 8.8 0c0 1.9-.4 3.7-1.2 5.3" />
      <path d="M10.6 14a1.4 1.4 0 0 1 2.8 0c0 2.3-.5 4.5-1.4 6.5" />
      <path d="M6.4 17.4c.5-1.2.8-2.5.8-3.8" />
    </>
  ),
  eye: (
    <>
      <path d="M2.4 12S6.2 5.4 12 5.4 21.6 12 21.6 12S17.8 18.6 12 18.6 2.4 12 2.4 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M10.1 6a9 9 0 0 1 1.9-.2c5.8 0 9.6 6.2 9.6 6.2a17 17 0 0 1-2.5 3.2" />
      <path d="M6.2 7.7A17 17 0 0 0 2.4 12s3.8 6.2 9.6 6.2c1.8 0 3.4-.5 4.8-1.3" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3.4 3.4l17.2 17.2" />
    </>
  ),

  // ── Feedback / status ──
  check: <path d="m4.8 12.6 4.8 4.8L19.2 6.6" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <path d="m8.2 12.2 2.7 2.7 5-5.3" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  'alert-triangle': (
    <>
      <path d="M10.4 3.6 2.6 17.2a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.6 3.6a1.8 1.8 0 0 0-3.2 0Z" />
      <path d="M12 9v4 M12 16.4h.01" />
    </>
  ),
  'alert-octagon': (
    <>
      <path d="M8.3 2.8h7.4l5.5 5.5v7.4l-5.5 5.5H8.3l-5.5-5.5V8.3l5.5-5.5Z" />
      <path d="M12 8v4.4 M12 16h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <path d="M12 11v5 M12 7.8h.01" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13.4" r="8" />
      <path d="M12 9.4v4l2.6 1.6 M9.2 2.6h5.6" />
    </>
  ),
  inbox: (
    <>
      <path d="M21.4 12.6h-5l-1.6 2.4H9.2l-1.6-2.4h-5" />
      <path d="M6.1 4.6h11.8a1.8 1.8 0 0 1 1.65 1.1l2.15 5.1a1.8 1.8 0 0 1 .15.72v6.1a1.8 1.8 0 0 1-1.8 1.8H4.45a1.8 1.8 0 0 1-1.8-1.8v-6.1c0-.25.05-.49.15-.72L4.45 5.7A1.8 1.8 0 0 1 6.1 4.6Z" />
    </>
  ),
  loader: (
    <path d="M12 2.8v4 M12 17.2v4 M4.5 12h4 M15.5 12h4 M6.7 6.7l2.8 2.8 M14.5 14.5l2.8 2.8 M6.7 17.3l2.8-2.8 M14.5 9.5l2.8-2.8" />
  ),

  // ── Movement ──
  refresh: <path d="M20.4 11.2a8.6 8.6 0 1 0-2.5 6.4L20.4 15 M20.4 5.6v5.6h-5.6" />,
  'chevron-down': <path d="m6.6 9.6 5.4 5.4 5.4-5.4" />,
  'chevron-up': <path d="m6.6 14.4 5.4-5.4 5.4 5.4" />,
  'chevron-left': <path d="m14.4 6.6-5.4 5.4 5.4 5.4" />,
  'chevron-right': <path d="m9.6 6.6 5.4 5.4-5.4 5.4" />,
  'arrow-right': <path d="M4.4 12h15.2 M13.4 5.8l6.2 6.2-6.2 6.2" />,
  'arrow-left': <path d="M19.6 12H4.4 M10.6 5.8 4.4 12l6.2 6.2" />,
  'arrow-down': <path d="M12 4.4v15.2 M5.8 13.4 12 19.6l6.2-6.2" />,
  'arrow-up': <path d="M12 19.6V4.4 M5.8 10.6 12 4.4l6.2 6.2" />,
  'external-link': (
    <path d="M14.4 4.4h5.2v5.2 M19.6 4.4l-8 8 M17.6 13.6v4.6a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 18.2V8.2a1.8 1.8 0 0 1 1.8-1.8h4.6" />
  ),
  link: (
    <path d="M9.6 13.9a4 4 0 0 0 5.7 0l3-3a4.05 4.05 0 0 0-5.73-5.73l-1.2 1.2 M14.4 10.1a4 4 0 0 0-5.7 0l-3 3a4.05 4.05 0 0 0 5.73 5.73l1.2-1.2" />
  ),

  // ── Data actions ──
  copy: (
    <>
      <rect x="9" y="9" width="11.6" height="11.6" rx="2" />
      <path d="M15 6.4V5.4a2 2 0 0 0-2-2H5.4a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2h1" />
    </>
  ),
  plus: <path d="M12 5.2v13.6 M5.2 12h13.6" />,
  minus: <path d="M5.2 12h13.6" />,
  trash: (
    <>
      <path d="M3.8 6.6h16.4 M8.6 6.6V4.4a1.2 1.2 0 0 1 1.2-1.2h4.4a1.2 1.2 0 0 1 1.2 1.2v2.2" />
      <path d="M6.2 6.6l.9 12.6a1.8 1.8 0 0 0 1.8 1.6h6.2a1.8 1.8 0 0 0 1.8-1.6l.9-12.6" />
      <path d="M10.4 10.6v6 M13.6 10.6v6" />
    </>
  ),
  download: <path d="M12 3.6v11.2 M7 10l5 5 5-5 M4.2 19.8h15.6" />,
  upload: <path d="M12 15.4V4.2 M7 9.2l5-5 5 5 M4.2 19.8h15.6" />,
  save: (
    <>
      <path d="M4.4 5.6a2 2 0 0 1 2-2h9l5 5v9.8a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2V5.6Z" />
      <path d="M8.4 3.6v5h6v-5 M8.4 20.4v-5.2h7.2v5.2" />
    </>
  ),
  edit: <path d="M15.4 4.4l4.2 4.2-10 10H5.4v-4.2l10-10Z M13.4 6.4l4.2 4.2" />,
  filter: <path d="M20.6 4.4H3.4l6.8 8v6.4l3.6 1.8v-8.2l6.8-8Z" />,

  // ── Identity ──
  user: (
    <>
      <circle cx="12" cy="8.2" r="4" />
      <path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9.4" cy="8.2" r="3.8" />
      <path d="M2.8 20.4a6.6 6.6 0 0 1 13.2 0" />
      <path d="M16.4 4.8a3.8 3.8 0 0 1 0 6.8 M17.6 14.6a6.6 6.6 0 0 1 3.6 5.8" />
    </>
  ),
  contact: (
    <>
      <rect x="4.4" y="3.4" width="15.2" height="17.2" rx="2" />
      <circle cx="12" cy="10.2" r="2.6" />
      <path d="M8.4 17.2a4 4 0 0 1 7.2 0 M2.6 7.6h2.2 M2.6 12h2.2 M2.6 16.4h2.2" />
    </>
  ),

  // ── Chrome ──
  globe: (
    <>
      <circle cx="12" cy="12" r="9.2" />
      <path d="M2.8 12h18.4" />
      <path d="M12 2.8c2.4 2.5 3.7 5.7 3.7 9.2s-1.3 6.7-3.7 9.2c-2.4-2.5-3.7-5.7-3.7-9.2S9.6 5.3 12 2.8Z" />
    </>
  ),
  'more-horizontal': <path d="M6 12h.01 M12 12h.01 M18 12h.01" />,
  menu: <path d="M3.8 6.6h16.4 M3.8 12h16.4 M3.8 17.4h16.4" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.2 M12 19.2v2.2 M2.6 12h2.2 M19.2 12h2.2 M5.4 5.4l1.6 1.6 M17 17l1.6 1.6 M5.4 18.6 7 17 M17 7l1.6-1.6" />
    </>
  ),
  moon: <path d="M20.4 14.6A8.8 8.8 0 0 1 9.4 3.6a8.8 8.8 0 1 0 11 11Z" />,
  monitor: (
    <>
      <rect x="2.8" y="4.2" width="18.4" height="12.4" rx="2" />
      <path d="M8.6 20.4h6.8 M12 16.6v3.8" />
    </>
  ),
  'qr-code': (
    <>
      <rect x="3.6" y="3.6" width="6.4" height="6.4" rx="1.2" />
      <rect x="14" y="3.6" width="6.4" height="6.4" rx="1.2" />
      <rect x="3.6" y="14" width="6.4" height="6.4" rx="1.2" />
      <path d="M14 14h2.6v2.6H14z M20.4 14v2.6 M14 20.4h6.4" />
    </>
  ),
  camera: (
    <>
      <path d="M4.4 8.4h2.9l1.5-2.4h6.4l1.5 2.4h2.9a1.8 1.8 0 0 1 1.8 1.8v8a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8v-8a1.8 1.8 0 0 1 1.8-1.8Z" />
      <circle cx="12" cy="14" r="3.2" />
    </>
  ),
  star: (
    <path d="m12 3.4 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.8l6.1-.9L12 3.4Z" />
  ),
  sparkles: (
    <path d="m12 3.4 1.9 4.7 4.7 1.9-4.7 1.9L12 16.6l-1.9-4.7-4.7-1.9 4.7-1.9L12 3.4Z M18.6 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
  ),
  flask: (
    <path d="M9.6 3.4h4.8 M10.4 3.4v5.5L4.9 18a2 2 0 0 0 1.75 3h10.7a2 2 0 0 0 1.75-3l-5.5-9.1V3.4 M7.4 14.6h9.2" />
  ),
  rocket: (
    <>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91 0Z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0 M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </>
  ),
} as const;

/** Every icon name the app can draw. */
export type IconName = keyof typeof ICON_PATHS;

/** Names sorted, for tests and for the icon-gallery in the docs panel. */
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'ref'> {
  name: IconName;
  /** Edge length in px. 20 suits body text; 16 for dense rows, 24 for nav. */
  size?: number;
  /**
   * Accessible name. Omit for icons that sit beside their own label — the label already
   * names the control, and a duplicate would make a screen reader say it twice. Pass one
   * for an icon-only button, where nothing else conveys the action.
   */
  label?: string;
  /** Stroke weight override. Heavier reads better at very small sizes. */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Render one icon at `size`, inheriting the surrounding text colour.
 *
 * `flex-shrink: 0` is set inline because an icon inside a flex row with long text is
 * otherwise squashed by the text: SVG has no intrinsic minimum width, so it collapses
 * before the text wraps.
 */
export function Icon({
  name,
  size = 20,
  label,
  strokeWidth = 1.75,
  className,
  style,
  ...rest
}: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon-svg ${className}` : 'icon-svg'}
      style={{ flexShrink: 0, ...style }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      /* The name is stamped on the element so that a test — and anyone inspecting
         the DOM — can tell which glyph rendered. A bare <path> is unreadable. */
      data-icon={name}
      {...rest}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
