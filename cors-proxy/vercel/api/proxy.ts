/**
 * Vercel Edge Function CORS proxy for Octra RPC.
 *
 * Deploy alongside the React app on Vercel. The function is exposed at:
 *   https://your-app.vercel.app/api/proxy
 *
 * Usage from the React app:
 *   - In Settings → RPC URL, enter: /api/proxy (relative URL — uses same origin)
 *   - Or set proxyUrl in src/rpc/client.ts to the full URL
 *
 * The function accepts a POST body of: { url, method, headers, body }
 * and forwards the request to the upstream (must be in the allowlist).
 */

export const config = {
  runtime: 'edge',
};

const ALLOWED_UPSTREAMS = [
  'https://octra.network',
  'https://devnet.octra.network',
  'https://testnet.octra.network',
];

interface ProxyRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export default async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let proxyReq: ProxyRequest;
  try {
    proxyReq = (await req.json()) as ProxyRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!proxyReq.url) {
    return json({ error: 'Missing "url" field' }, 400);
  }

  // Validate upstream
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(proxyReq.url);
  } catch {
    return json({ error: 'Invalid upstream URL' }, 400);
  }
  if (!ALLOWED_UPSTREAMS.some((u) => upstreamUrl.href.startsWith(u))) {
    return json(
      { error: `Upstream not allowed: ${upstreamUrl.origin}` },
      403,
    );
  }

  // Forward
  const upstreamResp = await fetch(proxyReq.url, {
    method: proxyReq.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(proxyReq.headers ?? {}),
    },
    body: proxyReq.body,
  });

  const respText = await upstreamResp.text();
  return new Response(respText, {
    status: upstreamResp.status,
    headers: {
      'Content-Type': upstreamResp.headers.get('Content-Type') ?? 'application/json',
      ...corsHeaders(),
    },
  });
}

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
