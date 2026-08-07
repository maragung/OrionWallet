/**
 * `oct://<circle_id>/<path>` URI parsing/building for the circle browser.
 *
 * Ported verbatim from the webcli reference (static/circles.js:149-207) so the
 * scheme semantics match the official client exactly:
 *   - an empty path defaults to `/index.html`
 *   - paths are always rooted with a single leading `/`
 *   - `circle_id` is the on-chain circle contract address ("oct" + base58)
 */

export interface CircleTarget {
  circleId: string;
  path: string;
  uri: string;
}

/** Normalize an asset path: empty → `/index.html`, else ensure a leading `/`. */
export function normalizeAssetPath(rawPath: string | null | undefined): string {
  const path = (rawPath || '').trim();
  if (!path) return '/index.html';
  return path.startsWith('/') ? path : `/${path}`;
}

/** Build a canonical `oct://` URI from a circle id + path. */
export function circleUriOf(circleId: string, path: string): string {
  return `oct://${circleId}${normalizeAssetPath(path)}`;
}

function decodeUriPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse an `oct://` URI. Returns null when the string is not a valid circle URI
 * (missing scheme or empty circle id). Query/hash fragments are stripped.
 */
export function parseCircleUri(uri: string | null | undefined): CircleTarget | null {
  const raw = (uri || '').trim();
  const decodedRaw = decodeUriPart(raw).trim();
  if (!decodedRaw.toLowerCase().startsWith('oct://')) {
    return null;
  }
  const rest = decodeUriPart(decodedRaw.slice(6)).split(/[?#]/, 1)[0] ?? '';
  if (!rest) {
    return null;
  }
  const slashIndex = rest.indexOf('/');
  if (slashIndex === -1) {
    return {
      circleId: rest,
      path: '/index.html',
      uri: circleUriOf(rest, '/index.html'),
    };
  }
  const circleId = rest.slice(0, slashIndex);
  const path = normalizeAssetPath(rest.slice(slashIndex));
  if (!circleId) {
    return null;
  }
  return { circleId, path, uri: circleUriOf(circleId, path) };
}

/**
 * Resolve a target from either an `oct://` URI or a bare circle id (+ optional
 * path). Mirrors webcli `parseCircleTarget` (circles.js:195-207).
 */
export function parseCircleTarget(rawCircle: string, rawPath?: string): CircleTarget {
  const parsedUri = parseCircleUri(rawCircle);
  if (parsedUri) return parsedUri;
  const circleId = (rawCircle || '').trim();
  const path = normalizeAssetPath(rawPath);
  return { circleId, path, uri: circleUriOf(circleId, path) };
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
