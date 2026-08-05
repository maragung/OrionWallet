import { describe, it, expect } from 'vitest';
import { RpcClient } from '../../src/rpc/client';

describe('RpcClient (JSON-RPC)', () => {
  /** Create a mock Response object for JSON-RPC */
  function mockResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(data),
      headers: new Headers({ 'Content-Type': 'application/json' }),
    } as Response;
  }

  it('constructs with URL and strips trailing slash', () => {
    const c = new RpcClient({ url: 'https://devnet.octrascan.io/rpc/' });
    expect(c.url).toBe('https://devnet.octrascan.io/rpc');
  });

  it('rpcCall sends JSON-RPC POST and returns result', async () => {
    let capturedBody = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return mockResponse({ jsonrpc: '2.0', result: { balance: '1000000', nonce: 5 }, id: 1 });
    }) as typeof fetch;

    const c = new RpcClient({ url: 'https://example.com/rpc', fetchImpl });
    const r = await c.rpcCall('octra_balance', ['oct123']);

    const parsed = JSON.parse(capturedBody);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('octra_balance');
    expect(parsed.params).toEqual(['oct123']);

    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ balance: '1000000', nonce: 5 });
  });

  it('rpcCall handles JSON-RPC error response', async () => {
    const c = new RpcClient({
      url: 'https://example.com/rpc',
      fetchImpl: (async () =>
        mockResponse({
          jsonrpc: '2.0',
          error: { code: -32601, message: 'method not found' },
          id: 1,
        })) as typeof fetch,
    });
    const r = await c.rpcCall('invalid_method', []);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('method not found');
  });

  it('rpcCall handles non-JSON response', async () => {
    const c = new RpcClient({
      url: 'https://example.com/rpc',
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          text: async () => '<html>Not JSON</html>',
          headers: new Headers(),
        }) as Response) as typeof fetch,
    });
    const r = await c.rpcCall('node_status', []);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Non-JSON response');
  });

  it('rpcCall handles HTTP error status', async () => {
    const c = new RpcClient({
      url: 'https://example.com/rpc',
      fetchImpl: (async () =>
        mockResponse(
          { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: 1 },
          500,
        )) as typeof fetch,
    });
    const r = await c.rpcCall('octra_balance', ['oct123']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('internal error');
  });

  it('aborts on timeout', async () => {
    // Mock fetch that respects the abort signal
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
        // Never resolve on its own
      });
    }) as typeof fetch;
    const c = new RpcClient({
      url: 'https://example.com/rpc',
      fetchImpl,
      timeoutMs: 100,
    });
    const start = Date.now();
    const r = await c.rpcCall('node_status', []);
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out');
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it('wraps network errors', async () => {
    const fetchImpl = (async () => {
      throw new Error('Network unavailable');
    }) as typeof fetch;
    const c = new RpcClient({ url: 'https://example.com/rpc', fetchImpl });
    const r = await c.rpcCall('node_status', []);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Network unavailable');
  });

  it('applies proxy URL when set', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      calledUrl = url.toString();
      return mockResponse({ jsonrpc: '2.0', result: {}, id: 1 });
    }) as typeof fetch;
    const c = new RpcClient({
      url: 'https://devnet.octrascan.io/rpc',
      proxyUrl: 'https://cors-proxy.example.com/?url=',
      fetchImpl,
    });
    await c.rpcCall('node_status', []);
    expect(calledUrl).toBe(
      'https://cors-proxy.example.com/?url=' +
        encodeURIComponent('https://devnet.octrascan.io/rpc'),
    );
  });

  it('getBalance calls octra_balance with address', async () => {
    let capturedBody = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return mockResponse({ jsonrpc: '2.0', result: { balance: '0', nonce: 0 }, id: 1 });
    }) as typeof fetch;
    const c = new RpcClient({ url: 'https://example.com/rpc', fetchImpl });
    await c.getBalance('oct123');
    const parsed = JSON.parse(capturedBody);
    expect(parsed.method).toBe('octra_balance');
    expect(parsed.params).toEqual(['oct123']);
  });

  it('getFee calls octra_recommendedFee', async () => {
    let capturedMethod = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedMethod = body.method;
      return mockResponse({
        jsonrpc: '2.0',
        result: { standard: '10000', encrypt: '1000000' },
        id: 1,
      });
    }) as typeof fetch;
    const c = new RpcClient({ url: 'https://example.com/rpc', fetchImpl });
    await c.getFee();
    expect(capturedMethod).toBe('octra_recommendedFee');
  });

  it('submitTx calls octra_submit with transaction', async () => {
    let capturedParams: unknown;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedParams = body.params;
      return mockResponse({
        jsonrpc: '2.0',
        result: { hash: 'abc', nonce: 1, accepted: true },
        id: 1,
      });
    }) as typeof fetch;
    const c = new RpcClient({ url: 'https://example.com/rpc', fetchImpl });
    await c.submitTx({ from: 'oct123', to: 'oct456', amount: '1000' });
    expect(capturedParams).toEqual([{ from: 'oct123', to: 'oct456', amount: '1000' }]);
  });
});
