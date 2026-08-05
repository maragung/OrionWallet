/**
 * Token transfer tests.
 *
 * The central concern is that a u128 amount survives the whole path — user
 * input -> base units -> JSON argument -> signed canonical bytes — without
 * ever touching Number. A corrupted amount cannot be repaired after signing,
 * because the Ed25519 signature covers the canonical JSON.
 */
import { describe, it, expect } from 'vitest';
import { encodeCallArgs } from '../../src/tx/call-args';
import { parseAmountToRaw, MAX_U128 } from '../../src/tokens/ocs01';
import { signContractCall } from '../../src/connect/typed-data';
import { importWalletFromSeed } from '../../src/wallet/wallet';
import { canonicalJsonForTx } from '../../src/tx/canonical-json';
import { verify } from '../../src/crypto/ed25519';
import { base64Decode } from '../../src/crypto/base64';

const wallet = importWalletFromSeed(new Uint8Array(32).fill(7));
const TOKEN = 'octD7jogbvECBLfks2xqRdhoA3gPW5kcLCNqhAYXp91FtcG';
const TO = 'oct39TH6PmokBGXVRibeAThZiomaweFqR5amvKpByTBqbhQ';

describe('encodeCallArgs', () => {
  it('matches JSON.stringify byte-for-byte when no bigint is present', () => {
    const cases: unknown[][] = [
      [],
      ['a', 'b'],
      [1, 2, 3],
      ['1', '1000'],
      [true, false, null],
      ['quote"and\\slash'],
      [{ nested: 'object' }, ['nested', 'array']],
      ['unicode ✓ 日本語'],
    ];
    for (const args of cases) {
      expect(encodeCallArgs(args)).toBe(JSON.stringify(args));
    }
  });

  it('emits a bigint as a bare JSON integer, not a string', () => {
    expect(encodeCallArgs([TO, 2500000n])).toBe(`["${TO}",2500000]`);
  });

  it('encodes 1e27 exactly, where JSON.stringify throws and Number corrupts', () => {
    const amount = 10n ** 27n;
    expect(encodeCallArgs([amount])).toBe('[1000000000000000000000000000]');
    expect(() => JSON.stringify([amount])).toThrow(TypeError);
    expect(JSON.stringify([Number(amount)])).toBe('[1e+27]');
  });

  it('encodes MAX_U128 exactly', () => {
    expect(encodeCallArgs([MAX_U128])).toBe(`[${MAX_U128.toString()}]`);
  });

  it('rejects values that cannot be represented as u128', () => {
    expect(() => encodeCallArgs([-1n])).toThrow(RangeError);
    expect(() => encodeCallArgs([MAX_U128 + 1n])).toThrow(RangeError);
  });

  it('refuses an unsafe integer rather than silently sending a wrong amount', () => {
    // 1e27 as a Number has already lost precision by the time we see it.
    expect(() => encodeCallArgs([1e27])).toThrow(/bigint/i);
    expect(() => encodeCallArgs([Number.NaN])).toThrow(RangeError);
    expect(() => encodeCallArgs([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });

  it('mirrors JSON.stringify for undefined inside an array', () => {
    expect(encodeCallArgs([undefined])).toBe(JSON.stringify([undefined]));
  });
});

describe('parseAmountToRaw', () => {
  it('scales a decimal amount into base units', () => {
    expect(parseAmountToRaw('1.5', 6)).toEqual({ ok: true, raw: 1500000n });
    expect(parseAmountToRaw('6', 6)).toEqual({ ok: true, raw: 6000000n });
    expect(parseAmountToRaw('0.000001', 6)).toEqual({ ok: true, raw: 1n });
    expect(parseAmountToRaw('624.814636022', 9)).toEqual({ ok: true, raw: 624814636022n });
  });

  it('handles decimals 0 as whole units', () => {
    expect(parseAmountToRaw('1000', 0)).toEqual({ ok: true, raw: 1000n });
  });

  it('preserves precision far beyond Number', () => {
    // 1e27 with 0 decimals — the mainnet `ao` supply.
    const r = parseAmountToRaw('1000000000000000000000000000', 0);
    expect(r).toEqual({ ok: true, raw: 10n ** 27n });
  });

  it('accepts leading/trailing forms', () => {
    expect(parseAmountToRaw('.5', 6)).toEqual({ ok: true, raw: 500000n });
    expect(parseAmountToRaw('5.', 6)).toEqual({ ok: true, raw: 5000000n });
    expect(parseAmountToRaw('  1.5  ', 6)).toEqual({ ok: true, raw: 1500000n });
  });

  it('ignores insignificant trailing zeros beyond the token precision', () => {
    expect(parseAmountToRaw('1.5000000000', 6)).toEqual({ ok: true, raw: 1500000n });
  });

  it('REJECTS an amount more precise than the token, rather than rounding it', () => {
    const r = parseAmountToRaw('1.9999999', 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('too-precise');
  });

  it('refuses to guess when decimals are unknown', () => {
    const r = parseAmountToRaw('1.5', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown-decimals');
  });

  it('rejects malformed, negative and empty input', () => {
    expect(parseAmountToRaw('', 6)).toMatchObject({ ok: false, error: 'empty' });
    expect(parseAmountToRaw('-1', 6)).toMatchObject({ ok: false, error: 'negative' });
    for (const bad of ['abc', '1.2.3', '1e5', '1,000', '0x10', '+1', '1 000']) {
      expect(parseAmountToRaw(bad, 6).ok).toBe(false);
    }
  });

  it('rejects an amount beyond u128', () => {
    const tooBig = (MAX_U128 + 1n).toString();
    expect(parseAmountToRaw(tooBig, 0)).toMatchObject({ ok: false, error: 'exceeds-u128' });
  });
});

describe('signed transfer transaction', () => {
  function buildTransfer(raw: bigint) {
    return signContractCall(wallet, {
      program: TOKEN,
      method: 'transfer',
      args: [TO, raw],
      nonce: 42,
      opType: 'call',
    });
  }

  it('produces the on-chain call shape: method in encrypted_data, args in message', () => {
    const { tx } = buildTransfer(2500000n);
    expect(tx.op_type).toBe('call');
    expect(tx.to).toBe(TOKEN);
    expect(tx.encrypted_data).toBe('transfer');
    // Matches the real mainnet transfer observed during design.
    expect(tx.message).toBe(`["${TO}",2500000]`);
    // Tokens move in contract state, not as native OCT value.
    expect(tx.amount).toBe('0');
  });

  it('carries a 1e27 amount into the signed bytes without corruption', () => {
    const { tx } = buildTransfer(10n ** 27n);
    expect(tx.message).toBe(`["${TO}",1000000000000000000000000000]`);
    // The corrupted Number form must NOT appear anywhere in the signed payload.
    expect(tx.message).not.toContain('1000000000000000013287555072');
    expect(tx.message).not.toContain('e+27');
  });

  it('signs canonical bytes that actually verify', () => {
    const { tx } = buildTransfer(2500000n);
    const canon = canonicalJsonForTx({
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      nonce: tx.nonce,
      ou: tx.ou,
      timestamp: tx.timestamp,
      op_type: tx.op_type,
      encrypted_data: tx.encrypted_data,
      message: tx.message,
    } as never);
    expect(verify(canon, base64Decode(tx.signature), wallet.pk)).toBe(true);
  });

  it('binds the amount to the signature — altering it invalidates the tx', () => {
    const { tx } = buildTransfer(2500000n);
    const tampered = { ...tx, message: `["${TO}",9999999]` };
    const canon = canonicalJsonForTx({
      from: tampered.from,
      to: tampered.to,
      amount: tampered.amount,
      nonce: tampered.nonce,
      ou: tampered.ou,
      timestamp: tampered.timestamp,
      op_type: tampered.op_type,
      encrypted_data: tampered.encrypted_data,
      message: tampered.message,
    } as never);
    // Proves the amount cannot be "fixed up" after signing.
    expect(verify(canon, base64Decode(tampered.signature), wallet.pk)).toBe(false);
  });

  it('rejects an out-of-range amount at signing time', () => {
    expect(() => buildTransfer(MAX_U128 + 1n)).toThrow(RangeError);
    expect(() => buildTransfer(-1n)).toThrow(RangeError);
  });

  it('round-trips user input through to the signed payload', () => {
    const parsed = parseAmountToRaw('2.5', 6);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { tx } = buildTransfer(parsed.raw);
    expect(tx.message).toBe(`["${TO}",2500000]`);
  });
});
