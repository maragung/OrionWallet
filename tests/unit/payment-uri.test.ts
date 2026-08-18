import { describe, it, expect } from 'vitest';
import { buildPaymentUri, parsePaymentUri } from '../../src/wallet/payment-uri';
import { isValidAddress } from '../../src/crypto/address';

/**
 * A real address, produced by deriveAddressFromPubkey and pinned here so this
 * test does not depend on key generation.
 */
const ADDR = 'octCXyDYUpqcvSVi2ArNyrrjLJ2kwpfMgQyX9a1Dnxvf6SS';

describe('address fixture', () => {
  it('is a valid address (guards the rest of this file)', () => {
    expect(isValidAddress(ADDR)).toBe(true);
  });
});

describe('parsePaymentUri', () => {
  it('reads a bare address', () => {
    expect(parsePaymentUri(ADDR)).toEqual({ addr: ADDR });
  });

  it('reads the octra: scheme, with and without slashes', () => {
    expect(parsePaymentUri(`octra:${ADDR}`)).toEqual({ addr: ADDR });
    expect(parsePaymentUri(`octra://${ADDR}`)).toEqual({ addr: ADDR });
    expect(parsePaymentUri(`OCTRA:${ADDR}`)).toEqual({ addr: ADDR });
  });

  it('picks up an amount', () => {
    expect(parsePaymentUri(`octra:${ADDR}?amount=1.5`)).toEqual({ addr: ADDR, amount: '1.5' });
    expect(parsePaymentUri(`octra:${ADDR}?amount=12`)).toEqual({ addr: ADDR, amount: '12' });
  });

  it('keeps the address when the amount is junk', () => {
    expect(parsePaymentUri(`octra:${ADDR}?amount=abc`)).toEqual({ addr: ADDR });
    expect(parsePaymentUri(`octra:${ADDR}?amount=-5`)).toEqual({ addr: ADDR });
    expect(parsePaymentUri(`octra:${ADDR}?foo=bar`)).toEqual({ addr: ADDR });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePaymentUri(`  octra:${ADDR}  `)).toEqual({ addr: ADDR });
  });

  it('rejects anything that is not a valid address', () => {
    expect(parsePaymentUri('')).toBeNull();
    expect(parsePaymentUri(null)).toBeNull();
    expect(parsePaymentUri(undefined)).toBeNull();
    expect(parsePaymentUri('https://example.com')).toBeNull();
    expect(parsePaymentUri('octshortaddress')).toBeNull();
    // Wrong prefix, right length.
    expect(parsePaymentUri('xyz' + ADDR.slice(3))).toBeNull();
    // '0' is not in the base58 alphabet.
    expect(parsePaymentUri(ADDR.slice(0, -1) + '0')).toBeNull();
  });

  it('round-trips what buildPaymentUri produces', () => {
    expect(parsePaymentUri(buildPaymentUri(ADDR))).toEqual({ addr: ADDR });
    expect(parsePaymentUri(buildPaymentUri(ADDR, '2.25'))).toEqual({ addr: ADDR, amount: '2.25' });
  });
});
