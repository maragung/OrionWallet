import { describe, it, expect } from 'vitest';
import { validatePin, assertValidPin } from '../../src/wallet/pin';

describe('pin validation', () => {
  it('accepts a strong short PIN with letter+digit+symbol', () => {
    expect(validatePin('abc123!@').ok).toBe(true);
    expect(validatePin('Pass1word!').ok).toBe(true);
  });

  it('accepts a long passphrase (>= 15 chars) without complexity', () => {
    expect(validatePin('simple passphrase').ok).toBe(true);
    expect(validatePin('alllowercaselettersok').ok).toBe(true);
    expect(validatePin('1234567890123456789').ok).toBe(true);
  });

  it('rejects too short', () => {
    expect(validatePin('abc').ok).toBe(false);
    expect(validatePin('abc12!').ok).toBe(false);
    expect(validatePin('abc123!').ok).toBe(false); // 7 chars
  });

  it('rejects too long (> 64)', () => {
    const long = 'a'.repeat(65);
    expect(validatePin(long).ok).toBe(false);
  });

  it('rejects short PIN without letter', () => {
    expect(validatePin('1234567!').ok).toBe(false);
  });

  it('rejects short PIN without digit', () => {
    expect(validatePin('abcdefg!').ok).toBe(false);
  });

  it('rejects short PIN without symbol', () => {
    expect(validatePin('abcdefg1').ok).toBe(false);
  });

  it('assertValidPin throws on invalid', () => {
    expect(() => assertValidPin('short')).toThrow();
    expect(() => assertValidPin('longenough1!')).not.toThrow();
  });

  it('rejects non-string input', () => {
    expect(validatePin(123 as unknown as string).ok).toBe(false);
  });
});
