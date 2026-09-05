import { describe, it, expect } from 'vitest';
import { validatePin, assertValidPin } from '../../src/wallet/pin';

describe('pin validation', () => {
  it('accepts any characters at 6+ chars — the content is the user’s choice', () => {
    expect(validatePin('123456').ok).toBe(true); // digits only
    expect(validatePin('abcdef').ok).toBe(true); // letters only
    expect(validatePin('Pass1word!').ok).toBe(true);
    expect(validatePin('simple passphrase').ok).toBe(true);
    expect(validatePin('にほんご123').ok).toBe(true); // any characters, really
  });

  it('rejects too short (< 6)', () => {
    expect(validatePin('').ok).toBe(false);
    expect(validatePin('abc12').ok).toBe(false); // 5 chars
    expect(validatePin('abc123!').ok).toBe(true); // 7 chars is fine now
  });

  it('rejects too long (> 64)', () => {
    const long = 'a'.repeat(65);
    expect(validatePin(long).ok).toBe(false);
  });

  it('assertValidPin throws on invalid', () => {
    expect(() => assertValidPin('short')).toThrow();
    expect(() => assertValidPin('123456')).not.toThrow();
  });

  it('rejects non-string input', () => {
    expect(validatePin(123 as unknown as string).ok).toBe(false);
  });
});
