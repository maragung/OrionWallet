import { describe, it, expect } from 'vitest';
import {
  canonicalizeMethod,
  METHODS,
  ORION_METHODS,
  SUPPORTED_METHODS,
} from '../../src/sdk/protocol';

/**
 * Regression cover for the "connect works but nothing else does" symptom.
 *
 * The Orion rebrand introduced `orion_wallet_*` as an alias namespace alongside
 * the generic `wallet_*` names. Both must be accepted by the dispatcher and map
 * to the same handler, so that dApps built against either namespace work
 * identically.
 *
 * Without canonicalization, an `orion_wallet_signMessage` request would be
 * rejected as METHOD_NOT_FOUND despite being semantically identical to
 * `wallet_signMessage`.
 */

describe('SDK namespace alias (orion_wallet_* ⇔ wallet_*)', () => {
  it('every METHODS entry has an ORION_METHODS equivalent', () => {
    for (const [key, genericMethod] of Object.entries(METHODS)) {
      const orionMethod = ORION_METHODS[key as keyof typeof ORION_METHODS];
      expect(orionMethod).toBeDefined();
      expect(orionMethod).toContain('orion_wallet_');
      expect(genericMethod).toContain('wallet_');
      // The suffix must match.
      const genericSuffix = genericMethod.replace('wallet_', '');
      const orionSuffix = orionMethod.replace('orion_wallet_', '');
      expect(orionSuffix).toBe(genericSuffix);
    }
  });

  it('SUPPORTED_METHODS includes both namespaces', () => {
    const supported = new Set(SUPPORTED_METHODS);
    expect(supported.has(METHODS.CONNECT)).toBe(true);
    expect(supported.has(ORION_METHODS.CONNECT)).toBe(true);
    expect(supported.has(METHODS.SIGN_MESSAGE)).toBe(true);
    expect(supported.has(ORION_METHODS.SIGN_MESSAGE)).toBe(true);
  });

  it('canonicalizeMethod reduces orion_wallet_* to wallet_*', () => {
    expect(canonicalizeMethod('orion_wallet_connect')).toBe('wallet_connect');
    expect(canonicalizeMethod('orion_wallet_signMessage')).toBe('wallet_signMessage');
    expect(canonicalizeMethod('orion_wallet_signContract')).toBe('wallet_signContract');
  });

  it('canonicalizeMethod passes wallet_* through unchanged', () => {
    expect(canonicalizeMethod('wallet_connect')).toBe('wallet_connect');
    expect(canonicalizeMethod('wallet_getBalance')).toBe('wallet_getBalance');
  });

  it('canonicalizeMethod passes unknown methods through unchanged', () => {
    expect(canonicalizeMethod('sendTransaction')).toBe('sendTransaction');
    expect(canonicalizeMethod('foo_bar')).toBe('foo_bar');
  });

  it('canonicalizeMethod is whitespace-tolerant', () => {
    expect(canonicalizeMethod('  orion_wallet_connect  ')).toBe('wallet_connect');
    expect(canonicalizeMethod(' wallet_getAccounts ')).toBe('wallet_getAccounts');
  });

  it('every orion_wallet_* method canonicalizes to its wallet_* equivalent', () => {
    for (const [key, orionMethod] of Object.entries(ORION_METHODS)) {
      const genericMethod = METHODS[key as keyof typeof METHODS];
      expect(canonicalizeMethod(orionMethod)).toBe(genericMethod);
    }
  });
});
