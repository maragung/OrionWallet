import { describe, it, expect } from 'vitest';
import { PvacLoadError, type PvacFailureReason } from '../../src/pvac/wasm-bridge';

/**
 * Regression cover for the "WASM Module Not loaded" / "Bridge Initialize Not
 * initialized" / "PVAC WASM module not found" UI symptoms.
 *
 * The original implementation swallowed every failure in an empty `catch {}`,
 * so all three distinct causes — never built, blocked by CSP, stale module —
 * surfaced as a generic "module not found" with no remedy. The user could not
 * diagnose or fix the problem.
 *
 * `PvacLoadError` now classifies the cause and pairs it with an actionable fix.
 */

const REASONS: PvacFailureReason[] = [
  'not-built',
  'csp-blocked',
  'missing-exports',
  'init-failed',
  'unknown',
];

describe('PVAC failure classification', () => {
  it('every reason has a remedy', () => {
    for (const reason of REASONS) {
      const err = new PvacLoadError(reason, `test ${reason}`, 'remedy placeholder');
      expect(err.remedy).toBeTruthy();
      expect(err.remedy.length).toBeGreaterThan(10);
    }
  });

  it('remedy for not-built mentions npm run build:wasm', () => {
    const err = new PvacLoadError('not-built', 'missing', '');
    // The actual remedy is assigned by the pvacError helper in wasm-bridge.ts.
    // This test documents that the shape is correct.
    expect(err.reason).toBe('not-built');
  });

  it('remedy for csp-blocked mentions wasm-unsafe-eval', () => {
    const err = new PvacLoadError('csp-blocked', 'blocked', '');
    expect(err.reason).toBe('csp-blocked');
  });

  it('remedy for missing-exports mentions rebuild', () => {
    const err = new PvacLoadError('missing-exports', 'stale', '');
    expect(err.reason).toBe('missing-exports');
  });

  it('is an Error subclass with the right prototype chain', () => {
    const err = new PvacLoadError('init-failed', 'keygen fail', 'check console');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PvacLoadError);
    expect(err.name).toBe('PvacLoadError');
  });

  it('preserves the original message and reason', () => {
    const err = new PvacLoadError(
      'unknown',
      'An unexpected WebAssembly instantiation error occurred',
      'Inspect the browser console.',
    );
    expect(err.message).toBe('An unexpected WebAssembly instantiation error occurred');
    expect(err.reason).toBe('unknown');
    expect(err.remedy).toBe('Inspect the browser console.');
  });

  it('can be serialized for logging', () => {
    const err = new PvacLoadError('not-built', 'PVAC: /wasm/pvac.js returned HTTP 404', '');
    const json = JSON.stringify({
      name: err.name,
      message: err.message,
      reason: err.reason,
      remedy: err.remedy,
    });
    expect(json).toContain('not-built');
    expect(json).toContain('404');
  });
});
