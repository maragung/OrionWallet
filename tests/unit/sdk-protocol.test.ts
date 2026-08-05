import { describe, it, expect } from 'vitest';
import {
  PROHIBITED_METHODS,
  isProhibitedMethod,
  negotiateVersion,
  negotiateCapabilities,
  isEnvelope,
  makeRequest,
  makeResponse,
  makeError,
  makeEvent,
  WALLET_CAPABILITIES,
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  ERROR_CODES,
  EVENTS,
} from '../../src/sdk/protocol';

describe('protocol: prohibited method denylist', () => {
  it('flags every declared prohibited method', () => {
    for (const m of PROHIBITED_METHODS) {
      expect(isProhibitedMethod(m), m).toBe(true);
    }
  });

  it('blocks execution intents regardless of prefix/casing', () => {
    const attempts = [
      'sendTransaction',
      'wallet_sendTransaction',
      'SENDTRANSACTION',
      'eth_sendTransaction',
      'eth_sendRawTransaction',
      'broadcastTransaction',
      'wallet_broadcast',
      'transfer',
      'wallet_transfer',
      'swap',
      'wallet_swap',
      'bridge',
      'wallet_bridge',
    ];
    for (const a of attempts) expect(isProhibitedMethod(a), a).toBe(true);
  });

  it('allows the legitimate signing/read methods', () => {
    const allowed = [
      'wallet_connect',
      'wallet_getBalance',
      'wallet_getAccounts',
      'wallet_signMessage',
      'wallet_signTypedData',
      'wallet_approveContract',
      'wallet_signContract',
    ];
    for (const a of allowed) expect(isProhibitedMethod(a), a).toBe(false);
  });
});

describe('protocol: version negotiation', () => {
  it('caps at the wallet version', () => {
    expect(negotiateVersion(PROTOCOL_VERSION)).toBe(PROTOCOL_VERSION);
    expect(negotiateVersion(PROTOCOL_VERSION + 5)).toBe(PROTOCOL_VERSION);
  });
  it('rejects versions below the minimum', () => {
    expect(negotiateVersion(MIN_PROTOCOL_VERSION - 1)).toBeNull();
    expect(negotiateVersion(0)).toBeNull();
    expect(negotiateVersion(NaN)).toBeNull();
  });
});

describe('protocol: capability negotiation', () => {
  it('returns all wallet capabilities when dApp requests none', () => {
    expect(negotiateCapabilities()).toEqual(WALLET_CAPABILITIES);
    expect(negotiateCapabilities([])).toEqual(WALLET_CAPABILITIES);
  });
  it('intersects requested with supported', () => {
    const got = negotiateCapabilities(['signMessage', 'somethingUnsupported']);
    expect(got).toContain('signMessage');
    expect(got).not.toContain('somethingUnsupported');
  });
});

describe('protocol: envelopes', () => {
  it('round-trips a request envelope shape', () => {
    const env = makeRequest('wallet_getBalance', { a: 1 }, 5);
    expect(isEnvelope(env)).toBe(true);
    expect(env.kind).toBe('req');
    expect(env.nonce).toBe(5);
    expect(typeof env.id).toBe('string');
    expect(typeof env.ts).toBe('number');
  });

  it('builds success, error, and event envelopes', () => {
    const res = makeResponse('id1', { ok: true }, 2);
    expect(res.kind).toBe('res');
    expect(res.result).toEqual({ ok: true });

    const errEnv = makeError('id1', { code: ERROR_CODES.USER_REJECTED, message: 'no' }, 3);
    expect(errEnv.error?.code).toBe(ERROR_CODES.USER_REJECTED);

    const evt = makeEvent(EVENTS.ACCOUNT_CHANGED, { address: 'oct...' }, 4);
    expect(evt.kind).toBe('evt');
    expect(evt.event).toBe(EVENTS.ACCOUNT_CHANGED);
  });

  it('rejects non-envelope inputs', () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({})).toBe(false);
    expect(isEnvelope({ v: 1, id: 'x', kind: 'bad', nonce: 1, ts: 1 })).toBe(false);
    expect(isEnvelope({ v: 1, id: 'x', kind: 'req', nonce: 1, ts: 1 })).toBe(true);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => makeRequest('m', {}, 1).id));
    expect(ids.size).toBe(1000);
  });
});
