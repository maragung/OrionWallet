import { describe, it, expect } from 'vitest';
import { toNodeWireTx, buildNodeWireJson, type SignedTxLike } from '../../src/sdk/wire-tx';
import { signTransaction, buildTxJson } from '../../src/tx/builder';
import { importWalletFromSeed } from '../../src/wallet/wallet';

/**
 * `toNodeWireTx` is the SDK's answer to the three things a dApp cannot guess
 * from a signed transaction it was handed: the recipient is `to_` on the wire,
 * `hash` is local-only, and key order is fixed by the node's
 * `Transaction.to_yojson`. Getting any of them wrong earns a bare "Malformed
 * JSON" from the node, so each one gets a test.
 */

const wallet = importWalletFromSeed(new Uint8Array(32).fill(7));

function signed(overrides: Partial<SignedTxLike> = {}): SignedTxLike {
  return {
    from: 'oct' + 'a'.repeat(44),
    to: 'oct' + 'b'.repeat(44),
    amount: '1500000',
    nonce: 7,
    ou: '10000',
    timestamp: 1700000000,
    op_type: 'standard',
    signature: 'c2ln',
    public_key: 'cHVi',
    hash: 'deadbeef',
    ...overrides,
  };
}

describe('toNodeWireTx', () => {
  it('renames "to" to "to_" and drops it', () => {
    const wire = toNodeWireTx(signed());
    expect(wire.to_).toBe('oct' + 'b'.repeat(44));
    expect('to' in wire).toBe(false);
  });

  it('drops the local-only hash', () => {
    const wire = toNodeWireTx(signed());
    expect('hash' in wire).toBe(false);
  });

  it('emits keys in the node’s to_yojson order', () => {
    const wire = toNodeWireTx(signed());
    expect(Object.keys(wire)).toEqual([
      'from',
      'to_',
      'amount',
      'nonce',
      'ou',
      'timestamp',
      'signature',
      'op_type',
      'public_key',
    ]);
  });

  it('appends message and encrypted_data only when present', () => {
    const bare = toNodeWireTx(signed());
    expect('message' in bare).toBe(false);
    expect('encrypted_data' in bare).toBe(false);

    const full = toNodeWireTx(signed({ message: 'hi', encrypted_data: '{"x":1}' }));
    expect(Object.keys(full).slice(-2)).toEqual(['message', 'encrypted_data']);
    expect(full.message).toBe('hi');
    expect(full.encrypted_data).toBe('{"x":1}');
  });

  it('keeps a pre-renamed to_ instead of overwriting it with an absent "to"', () => {
    // A caller that already did the rename must not get its recipient replaced
    // by undefined — that would submit a transaction to nobody.
    const input = { ...signed(), to_: 'oct' + 'c'.repeat(44) } as unknown as SignedTxLike;
    delete (input as Record<string, unknown>).to;
    const wire = toNodeWireTx(input);
    expect(wire.to_).toBe('oct' + 'c'.repeat(44));
  });

  it('prefers to_ over a conflicting "to"', () => {
    const wire = toNodeWireTx({ ...signed(), to_: 'oct' + 'c'.repeat(44) } as SignedTxLike);
    expect(wire.to_).toBe('oct' + 'c'.repeat(44));
  });

  it('passes unknown keys through rather than stripping them', () => {
    // Silently dropping an unrecognised field would remove something the
    // signature covers and make the submit invalid, so a future node field has
    // to survive an old copy of this module.
    const wire = toNodeWireTx({ ...signed(), future_field: 42 } as SignedTxLike);
    expect(wire.future_field).toBe(42);
    // …and it lands after the fields this module places itself.
    expect(Object.keys(wire).at(-1)).toBe('future_field');
  });

  it('buildNodeWireJson is the serialized form of toNodeWireTx', () => {
    const tx = signed();
    expect(buildNodeWireJson(tx)).toBe(JSON.stringify(toNodeWireTx(tx)));
  });

  it('agrees byte-for-byte with the wallet’s own submit payload', () => {
    // The wallet's builder routes through this module. If the two ever diverge,
    // a dApp-submitted transaction stops matching a wallet-submitted one — the
    // exact drift this shared implementation exists to prevent.
    const tx = signTransaction({
      secretKey: wallet.sk,
      publicKeyB64: wallet.pubB64,
      fields: {
        from: wallet.addr,
        to: 'oct' + 'd'.repeat(44),
        amount: '1000000',
        nonce: 1,
        ou: '10000',
        timestamp: 1700000000,
        op_type: 'standard',
      },
    });
    expect(buildNodeWireJson(tx as unknown as SignedTxLike)).toBe(buildTxJson(tx));
  });
});
