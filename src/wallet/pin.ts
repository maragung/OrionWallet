/**
 * PIN validation policy.
 *
 * The PIN is the user's own secret for an account, so its content is entirely
 * up to them — any characters are allowed, including plain digits like "123456".
 * The only rule is a floor on length:
 *
 *   - Length: 6..64 chars (6 is the minimum worth encrypting keys with; 64 keeps
 *     the PBKDF2 input bounded)
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
  if (pin.length < 6) return { ok: false, reason: 'PIN must be at least 6 characters' };
  if (pin.length > 64) return { ok: false, reason: 'PIN must be at most 64 characters' };
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
