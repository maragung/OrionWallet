/**
 * `oct://<circle_id>/<path>` URI parsing/building for the circle browser.
 *
 * Mirrors the webcli reference (static/circle_bridge_policy.js) so the scheme
 * semantics match the official client exactly:
 *   - an empty path defaults to `/index.html`
 *   - `circle_id` must be a well-formed circle address ("oct" + 44 base58)
 *   - paths are canonicalised: `.` segments dropped, `..` rejected outright,
 *     and the result is capped at 1024 characters
 */

export interface CircleTarget {
  circleId: string;
  path: string;
  uri: string;
}

/** Maximum canonical asset path length (webcli circle_bridge_policy.js). */
export const MAX_PATH_LENGTH = 1024;

/**
 * A circle id is `oct` followed by 44 base58 characters (no 0, O, I, l).
 * Validating this keeps malformed ids from ever reaching the RPC layer.
 */
const CIRCLE_ID_PATTERN = /^oct[1-9A-HJ-NP-Za-km-z]{44}$/;

/** True when `circleId` is a syntactically valid circle address. */
export function isValidCircleId(circleId: unknown): circleId is string {
  return typeof circleId === 'string' && CIRCLE_ID_PATTERN.test(circleId);
}

/** Normalize an asset path: empty → `/index.html`, else ensure a leading `/`. */
export function normalizeAssetPath(rawPath: string | null | undefined): string {
  const path = (rawPath || '').trim();
  if (!path) return '/index.html';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Canonicalise an asset path, or return `''` when it is unusable.
 *
 * Drops empty and `.` segments, rejects any `..` (no traversal outside the
 * circle), and enforces the length cap. Percent-encoding is decoded first so
 * `%2e%2e` cannot smuggle a traversal past the check.
 */
export function canonicalAssetPath(rawPath: unknown): string {
  if (typeof rawPath !== 'string') return '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.trim());
  } catch {
    return '';
  }
  const path = decoded.startsWith('/') ? decoded : `/${decoded}`;
  const segments = path.split('/').filter((s) => s && s !== '.');
  if (segments.includes('..')) return '';
  const canonical = segments.length ? `/${segments.join('/')}` : '/';
  return canonical.length <= MAX_PATH_LENGTH ? canonical : '';
}

/** Build a canonical `oct://` URI from a circle id + path. */
export function circleUriOf(circleId: string, path: string): string {
  return `oct://${circleId}${normalizeAssetPath(path)}`;
}

/**
 * Parse an `oct://` URI. Returns null unless the circle id is well-formed and
 * the path canonicalises. Query/hash fragments are stripped.
 */
export function parseCircleUri(uri: string | null | undefined): CircleTarget | null {
  if (typeof uri !== 'string') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri.trim());
  } catch {
    return null;
  }
  if (!decoded.toLowerCase().startsWith('oct://')) return null;
  const rest = decoded.slice(6).split(/[?#]/, 1)[0] ?? '';
  const slash = rest.indexOf('/');
  const circleId = slash < 0 ? rest : rest.slice(0, slash);
  if (!isValidCircleId(circleId)) return null;
  const path = canonicalAssetPath(slash < 0 ? '/index.html' : rest.slice(slash));
  if (!path) return null;
  return { circleId, path, uri: `oct://${circleId}${path}` };
}

/**
 * Resolve a target from either an `oct://` URI or a bare circle id (+ optional
 * path). When the circle id is not usable the `uri` comes back empty, which the
 * caller treats as "nothing to navigate to".
 */
export function parseCircleTarget(rawCircle: string, rawPath?: string): CircleTarget {
  const parsedUri = parseCircleUri(rawCircle);
  if (parsedUri) return parsedUri;
  const circleId = (rawCircle || '').trim();
  const path = canonicalAssetPath(rawPath ?? '/index.html') || '/index.html';
  return {
    circleId,
    path,
    uri: isValidCircleId(circleId) ? `oct://${circleId}${path}` : '',
  };
}

/**
 * Resolve a possibly-relative resource spec against a base circle path to a
 * canonical circle path. Remote/`data:`/`blob:`/`javascript:` specs are returned
 * unchanged so callers can decide to block them.
 * Mirrors webcli `resolveCirclePath` (circles.js:1172-1176).
 */
export function resolveCirclePath(basePath: string, spec: string): string {
  if (!spec || spec.startsWith('#') || isDataSpec(spec) || isBlockedRemoteSpec(spec)) {
    return spec;
  }
  const base = `https://circle.local${normalizeAssetPath(basePath)}`;
  return new URL(spec, base).pathname;
}

/** True for `http(s)://`, protocol-relative `//`, `javascript:` and `mailto:` specs. */
export function isBlockedRemoteSpec(spec: string): boolean {
  return /^(https?:)?\/\//i.test(spec) || /^javascript:/i.test(spec) || /^mailto:/i.test(spec);
}

/** True for `data:` / `blob:` specs (already inlined, safe to leave). */
export function isDataSpec(spec: string): boolean {
  return /^data:/i.test(spec) || /^blob:/i.test(spec);
}

/** Heuristic: does this content type carry text we can inline as a string? */
export function isTextContent(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('javascript') ||
    contentType.includes('xml') ||
    contentType.includes('svg')
  );
}
