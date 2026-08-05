/**
 * Cloudflare Workers CORS proxy for Octra RPC.
 *
 * Deploy this as a Cloudflare Worker to proxy requests from the browser
 * to the Octra RPC node, bypassing browser CORS restrictions.
 *
 * Deploy steps:
 *   1. Install wrangler: npm install -g wrangler
 *   2. Login: wrangler login
 *   3. Deploy: wrangler deploy
 *
 * Usage from the React app (in Settings → RPC URL):
 *   - Set "RPC URL" to: https://your-worker.workers.dev/proxy?url=https://octra.network/rpc
 *   - Or: configure the proxyUrl option in src/rpc/client.ts directly
 *
 * SECURITY:
 *   - This proxy is wide-open (anyone can use it). For production, add
 *     rate limiting, referer checks, or auth tokens.
 *   - The proxy only allows HTTPS upstream URLs to prevent SSRF.
 *   - The proxy strips the Origin and Host headers to prevent leaking
 *     the origin to the upstream.
 */

const ALLOWED_UPSTREAMS = [
  'https://octra.network',
  'https://devnet.octra.network',
  'https://testnet.octra.network',
  // Add your own RPC endpoints here
];

interface ProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    void env;
    void ctx;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Only allow POST to /proxy
    const url = new URL(request.url);
    if (url.pathname !== '/proxy') {
      return json({ error: 'Not found' }, 404);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // Parse the proxy request
    let proxyReq: ProxyRequest;
    try {
      proxyReq = (await request.json()) as ProxyRequest;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!proxyReq.url) {
      return json({ error: 'Missing "url" field' }, 400);
    }

    // Validate upstream is in the allowlist
    const upstreamUrl = new URL(proxyReq.url);
    if (!ALLOWED_UPSTREAMS.some((u) => upstreamUrl.href.startsWith(u))) {
      return json(
        { error: `Upstream not allowed: ${upstreamUrl.origin}. Allowed: ${ALLOWED_UPSTREAMS.join(', ')}` },
        403,
      );
    }

    // Forward the request
    const upstreamResp = await fetch(proxyReq.url, {
      method: proxyReq.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'orion-wallet/0.1.0 (+https://github.com/octra-labs/webcli)',
      },
      body: proxyReq.body,
    });

    // Read the response
    const respText = await upstreamResp.text();

    // Return with CORS headers
    return new Response(respText, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('Content-Type') ?? 'application/json',
        ...corsHeaders(),
      },
    });
  },
};

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
