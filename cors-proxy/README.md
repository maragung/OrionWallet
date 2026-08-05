# CORS Proxy for Octra RPC

The browser cannot directly call the Octra RPC endpoint if it doesn't send CORS headers. This directory contains ready-to-deploy CORS proxy implementations.

## Option 1: Cloudflare Workers (recommended — free tier covers most usage)

```bash
cd cf-worker
npm install
npx wrangler login
npx wrangler deploy
```

After deploy, in the React app's Settings:
- **RPC URL**: `https://octra-cors-proxy.<your-subdomain>.workers.dev/proxy?url=https://octra.network/rpc`

## Option 2: Vercel Edge Function (deploy alongside the React app)

If you deploy the React app on Vercel, copy `vercel/api/proxy.ts` to your Vercel project's `api/proxy.ts` directory. Vercel will auto-detect it as an Edge Function.

After deploy, in Settings:
- **RPC URL**: `/api/proxy` (relative URL — same origin as the app)

## Security Notes

- **Allowlist**: Both proxies restrict upstreams to a hardcoded list. Edit `ALLOWED_UPSTREAMS` in the proxy file to add your own endpoints.
- **No rate limiting**: For production, add Cloudflare's built-in rate limiting or Vercel's Edge Config quotas.
- **No auth**: Anyone can use the proxy. For production, consider adding an API key or referer check.
- **SSRF protection**: Both proxies validate the upstream URL is HTTPS and in the allowlist before forwarding.

## How the React app uses the proxy

The `RpcClient` class accepts an optional `proxyUrl` (see `src/rpc/client.ts`). When set, all RPC requests are sent to the proxy with the upstream URL encoded in the request body:

```typescript
const rpc = new RpcClient({
  url: 'https://octra.network/rpc',
  // No proxy needed if Octra enables CORS:
  // proxyUrl: undefined,
});
```

The Settings panel lets users set the RPC URL directly. The format `https://proxy.example.com/?url=<encoded-upstream>` is supported.

## Custom proxy format

If you have a different proxy format (e.g., URL prefix instead of body parameter), you can adapt the `RpcClient.endpoint()` method in `src/rpc/client.ts`.
