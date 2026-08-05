/**
 * PIN validation policy.
 * Ported from main.cpp validate_pin.
 *
 * Rules:
 *   - Length: 8..64 chars
 *   - If length < 15: must contain at least one letter, one digit, and one symbol
 *   - Symbols: any non-alphanumeric character
 *   - If length >= 15: any characters allowed (passphrase-style)
 */

const attemptLog: Map<string, { count: number; lastAttempt: number }> = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

export interface PinValidationResult {
  ok: boolean;
  reason?: string;
}

export function validatePin(pin: string): PinValidationResult {
  if (typeof pin !== 'string') return { ok: false, reason: 'PIN must be a string' };
  if (pin.length < 8) return { ok: false, reason: 'PIN must be at least 8 characters' };
  if (pin.length > 64) return { ok: false, reason: 'PIN must be at most 64 characters' };
  if (pin.length < 15) {
    const hasLetter = /[a-zA-Z]/.test(pin);
    const hasDigit = /[0-9]/.test(pin);
    const hasSymbol = /[^a-zA-Z0-9]/.test(pin);
    if (!hasLetter) return { ok: false, reason: 'PIN < 15 chars must contain a letter' };
    if (!hasDigit) return { ok: false, reason: 'PIN < 15 chars must contain a digit' };
    if (!hasSymbol) return { ok: false, reason: 'PIN < 15 chars must contain a symbol' };
  }
  return { ok: true };
}

/** Throw on invalid PIN. */
export function assertValidPin(pin: string): void {
  const r = validatePin(pin);
  if (!r.ok) throw new Error(`Invalid PIN: ${r.reason}`);
}

/**
 * Record a PIN attempt for rate limiting.
 * Returns true if the attempt is allowed, false if the user is locked out.
 */
export function recordPinAttempt(addr: string): boolean {
  const now = Date.now();
  const entry = attemptLog.get(addr);
  if (entry && now - entry.lastAttempt < LOCKOUT_MS && entry.count >= MAX_ATTEMPTS) {
    return false;
  }
  if (!entry || now - entry.lastAttempt > LOCKOUT_MS) {
    attemptLog.set(addr, { count: 1, lastAttempt: now });
  } else {
    entry.count++;
    entry.lastAttempt = now;
  }
  return true;
}

/** Reset the PIN attempt counter for an address (call on successful unlock). */
export function resetPinAttempts(addr: string): void {
  attemptLog.delete(addr);
}
