import { describe, it, expect } from 'vitest';
import { RpcClient } from '../../src/rpc/client';
import { fetchNextNonce } from '../../src/api/nonce';

/**
 * Regression cover for duplicate/invalid nonce when a transaction is pending.
 *
 * `octra_balance` reports `nonce` (last CONFIRMED) and `pending_nonce` (highest
 * consumed by a PENDING staging tx). Building a new tx with `nonce + 1` while a
 * tx is still pending reuses an in-flight nonce and the node rejects it.
 * fetchNextNonce must always use `(pending_nonce ?? nonce) + 1`.
 */

function makeClient(result: unknown, error?: string): RpcClient {
  const fetchImpl = (async () => {
    if (error) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ jsonrpc: '2.0', error: { message: error }, id: 1 }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', result, id: 1 }),
    } as Response;
  }) as typeof fetch;
  return new RpcClient({ url: 'https://example.com/rpc', fetchImpl });
}

describe('fetchNextNonce', () => {
  it('returns confirmed nonce + 1 when there is no pending tx', async () => {
    const rpc = makeClient({ balance: '1000000', nonce: 5 });
    await expect(fetchNextNonce(rpc, 'oct123')).resolves.toBe(6);
  });

  it('uses pending_nonce + 1 when a tx is pending (avoids duplicate nonce)', async () => {
    const rpc = makeClient({ balance: '1000000', nonce: 5, pending_nonce: 7 });
    await expect(fetchNextNonce(rpc, 'oct123')).resolves.toBe(8);
  });

  it('returns 1 for a brand-new account with no on-chain state', async () => {
    const rpc = makeClient(null, 'sender not found');
    await expect(fetchNextNonce(rpc, 'octNew')).resolves.toBe(1);
  });

  it('throws when the balance call fails for a real reason', async () => {
    const rpc = makeClient(null, 'node unreachable');
    await expect(fetchNextNonce(rpc, 'oct123')).rejects.toThrow('Failed to fetch nonce');
  });

  it('treats missing nonce as 0 (next = 1)', async () => {
    const rpc = makeClient({ balance: '0' });
    await expect(fetchNextNonce(rpc, 'oct123')).resolves.toBe(1);
  });
});
