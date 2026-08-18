/**
 * Endpoint policy — which RPC/relayer URLs the wallet is willing to fetch.
 *
 * Everything here is about `http://` endpoints. Three separate things can block
 * one, and they fail at different layers with unhelpful errors, so this module
 * decides up front and says which one it is:
 *
 *   1. MIXED CONTENT — an https:// page may not fetch http:// at all. The
 *      browser drops the request before it leaves the tab. Nothing the wallet
 *      stores can change that; only serving the wallet over http:// (or putting
 *      an https proxy in front of the endpoint) can.
 *   2. CSP — `index.html` ships `connect-src 'self' https:` plus loopback. A
 *      non-loopback http origin needs the build flag `VITE_ALLOW_HTTP_ENDPOINTS=1`,
 *      which appends `http:` to that directive at build time. It is a build flag
 *      because a meta-tag CSP cannot be loosened at runtime.
 *   3. THE USER'S ALLOWLIST — `Settings.allowedInsecureOrigins`. Even when the
 *      browser would permit it, a plaintext endpoint sees every address and
 *      transaction the wallet asks about, and anyone on the path can rewrite the
 *      answers. So it takes an explicit per-origin opt-in.
 *
 * Loopback (`localhost`, `127.0.0.0/8`, `[::1]`) is exempt from the allowlist:
 * browsers treat it as potentially trustworthy, it cannot be intercepted off the
 * machine, and "run my own node" is the main reason to want http at all.
 *
 * Explorer URLs are NOT covered: they are only ever used as link targets, and a
 * navigation to http:// is not a fetch — no CSP `connect-src`, no mixed-content
 * block. An http explorer works without any of this.
 */

/** How an endpoint was decided. */
export type EndpointKind =
  | 'https'
  | 'loopback'
  | 'allowlisted'
  | 'proxied'
  | 'invalid'
  | 'scheme'
  | 'mixed-content'
  | 'csp'
  | 'not-allowlisted';

export interface EndpointVerdict {
  allowed: boolean;
  kind: EndpointKind;
  /** Why, in words the UI can show as-is. Always set. */
  message: string;
  /** Origin the allowlist would need, when that is the missing piece. */
  origin?: string;
}

export interface EndpointContext {
  /** Origins the user has explicitly trusted, e.g. `http://10.0.0.5:8080`. */
  allowlist?: string[];
  /** Protocol of the page doing the fetching. Defaults to the live one. */
  pageProtocol?: string;
  /** Whether the shipped CSP permits non-loopback `http:`. Defaults to the build flag. */
  cspAllowsHttp?: boolean;
  /** Proxy prefix in front of the endpoint; when set, it is what gets fetched. */
  proxyUrl?: string;
}

/** Loopback names that browsers treat as potentially trustworthy. */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  // 127.0.0.0/8 — the whole range, not just 127.0.0.1.
  return /^127(\.\d{1,3}){3}$/.test(h);
}

/** True for a URL browsers consider secure enough to fetch from anywhere. */
export function isLoopbackUrl(url: string): boolean {
  const parsed = parseEndpoint(url);
  return !!parsed && isLoopbackHostname(parsed.hostname);
}

/** Parse an endpoint URL, or null when it is not a usable absolute URL. */
export function parseEndpoint(url: string): URL | null {
  try {
    const trimmed = url.trim();
    if (!trimmed) return null;
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/**
 * The `scheme://host[:port]` an allowlist entry is keyed by.
 *
 * Accepts a full URL or a bare origin, and tolerates a missing scheme by
 * assuming `http://` — nobody types `http://` when adding one by hand, and the
 * allowlist only ever holds insecure origins anyway.
 */
export function normalizeOrigin(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = parseEndpoint(withScheme);
  if (!parsed) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/** Whether this build's CSP was widened to allow non-loopback `http:`. */
export function cspAllowsHttpEndpoints(): boolean {
  // Vite inlines VITE_-prefixed vars, so this is a constant in a real build.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_ALLOW_HTTP_ENDPOINTS === '1' || env?.VITE_ALLOW_HTTP_ENDPOINTS === 'true';
}

function pageProtocolOf(ctx: EndpointContext): string {
  if (ctx.pageProtocol) return ctx.pageProtocol;
  if (typeof location !== 'undefined' && location.protocol) return location.protocol;
  // Non-browser callers (tests, tooling): assume the strictest case.
  return 'https:';
}

/** Whether `origin` appears in the user's allowlist, comparing normalised forms. */
export function isOriginAllowlisted(origin: string, allowlist: string[] | undefined): boolean {
  if (!allowlist?.length) return false;
  const want = normalizeOrigin(origin);
  if (!want) return false;
  return allowlist.some((entry) => normalizeOrigin(entry) === want);
}

/**
 * Decide whether the wallet may fetch `url`.
 *
 * Pure: every input that matters is in `ctx`, so the UI, the store and the tests
 * all get the same answer for the same situation.
 */
export function checkEndpoint(url: string, ctx: EndpointContext = {}): EndpointVerdict {
  // A proxy in front of the endpoint means the browser never touches the
  // endpoint itself — the proxy URL is what has to pass.
  const proxy = ctx.proxyUrl?.trim();
  if (proxy) {
    const inner = checkEndpoint(proxy, { ...ctx, proxyUrl: undefined });
    return inner.allowed
      ? {
          allowed: true,
          kind: 'proxied',
          message: `Fetched through the proxy at ${normalizeOrigin(proxy) ?? proxy}, so the endpoint's own scheme does not apply.`,
        }
      : { ...inner, message: `The configured proxy is unusable: ${inner.message}` };
  }

  const parsed = parseEndpoint(url);
  if (!parsed) {
    return { allowed: false, kind: 'invalid', message: 'That is not a valid absolute URL.' };
  }
  if (parsed.protocol === 'https:') {
    return { allowed: true, kind: 'https', message: 'Encrypted endpoint — no restrictions apply.' };
  }
  if (parsed.protocol !== 'http:') {
    return {
      allowed: false,
      kind: 'scheme',
      message: `Only http:// and https:// endpoints are supported, not ${parsed.protocol}`,
    };
  }

  if (isLoopbackHostname(parsed.hostname)) {
    return {
      allowed: true,
      kind: 'loopback',
      message:
        'Loopback endpoint — the request never leaves this machine, so plaintext is not a risk here.',
      origin: parsed.origin,
    };
  }

  // Non-loopback http from here on: the three blockers, most fundamental first.
  if (pageProtocolOf(ctx) === 'https:') {
    return {
      allowed: false,
      kind: 'mixed-content',
      origin: parsed.origin,
      message:
        `The wallet is served over https://, and browsers refuse to fetch http:// from an https:// page ` +
        `(mixed content). Trusting ${parsed.origin} here would not change that. Put an https proxy in ` +
        `front of the node, run the node behind TLS, or open the wallet from a plain-http/localhost build.`,
    };
  }
  const cspOk = ctx.cspAllowsHttp ?? cspAllowsHttpEndpoints();
  if (!cspOk) {
    return {
      allowed: false,
      kind: 'csp',
      origin: parsed.origin,
      message:
        `This build's Content-Security-Policy only permits https:// and loopback endpoints. Rebuild with ` +
        `VITE_ALLOW_HTTP_ENDPOINTS=1 to allow http:// origins like ${parsed.origin}, or use a loopback address.`,
    };
  }
  if (isOriginAllowlisted(parsed.origin, ctx.allowlist)) {
    return {
      allowed: true,
      kind: 'allowlisted',
      origin: parsed.origin,
      message: `${parsed.origin} is on your list of trusted plaintext endpoints.`,
    };
  }
  return {
    allowed: false,
    kind: 'not-allowlisted',
    origin: parsed.origin,
    message:
      `${parsed.origin} is a plaintext endpoint, so anyone on the network path can read every balance ` +
      `and history lookup the wallet makes, and alter the replies. Add it to the trusted list in ` +
      `Settings → Network if that is acceptable on this network.`,
  };
}

/** `checkEndpoint`, as a throw. Message is the verdict's own wording. */
export function assertEndpointAllowed(url: string, ctx: EndpointContext = {}): void {
  const verdict = checkEndpoint(url, ctx);
  if (!verdict.allowed) throw new Error(verdict.message);
}

/**
 * One-line warning for an endpoint that works but is not encrypted, or null when
 * there is nothing to say. Drives the header badge.
 */
export function endpointWarning(url: string, ctx: EndpointContext = {}): string | null {
  const verdict = checkEndpoint(url, ctx);
  if (!verdict.allowed) return verdict.message;
  if (verdict.kind === 'allowlisted') {
    return `Unencrypted RPC: ${verdict.origin} can see and alter everything this wallet asks it.`;
  }
  return null;
}
