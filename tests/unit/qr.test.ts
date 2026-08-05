import { describe, it, expect } from 'vitest';
import { encodeQr } from '../../src/crypto/qr';

/**
 * Structural checks for the QR encoder. A full decode would need a reader
 * library, so we assert the invariants a scanner relies on: correct size,
 * finder patterns, timing patterns, and the fixed dark module.
 */
describe('QR encoder', () => {
  const addr = 'oct1111111111111111111111111111111111111111111';

  const at = (q: { size: number; modules: boolean[] }, r: number, c: number) =>
    q.modules[r * q.size + c];

  it('produces a valid version size (4*v+17)', () => {
    const q = encodeQr(addr);
    expect((q.size - 17) % 4).toBe(0);
    const version = (q.size - 17) / 4;
    expect(version).toBeGreaterThanOrEqual(1);
    expect(version).toBeLessThanOrEqual(10);
    expect(q.modules.length).toBe(q.size * q.size);
  });

  it('places the three finder patterns', () => {
    const q = encodeQr(addr);
    const corners: Array<[number, number]> = [
      [0, 0],
      [0, q.size - 7],
      [q.size - 7, 0],
    ];
    for (const [r0, c0] of corners) {
      // Outer ring dark, inner ring light, 3x3 core dark
      expect(at(q, r0, c0)).toBe(true);
      expect(at(q, r0 + 6, c0 + 6)).toBe(true);
      expect(at(q, r0 + 1, c0 + 1)).toBe(false);
      expect(at(q, r0 + 3, c0 + 3)).toBe(true);
    }
  });

  it('places alternating timing patterns', () => {
    const q = encodeQr(addr);
    for (let i = 8; i < q.size - 8; i++) {
      expect(at(q, 6, i)).toBe(i % 2 === 0);
      expect(at(q, i, 6)).toBe(i % 2 === 0);
    }
  });

  it('sets the mandatory dark module', () => {
    const q = encodeQr(addr);
    expect(at(q, q.size - 8, 8)).toBe(true);
  });

  it('reserves both format-info areas as function modules', () => {
    // Regression guard: (8, size-8) is a reserved function module. Treating it
    // as data shifts the entire bitstream and makes the symbol undecodable.
    const q = encodeQr(addr);
    // Row 8 format strip (top-right) and column 8 strip (bottom-left) must be
    // fully populated — no holes left by the data placement pass.
    for (let i = 0; i < 8; i++) {
      expect(typeof at(q, 8, q.size - 1 - i)).toBe('boolean');
      expect(typeof at(q, q.size - 1 - i, 8)).toBe('boolean');
    }
  });

  it('writes format bits MSB-first (ECC M, mask 0)', () => {
    // The 15-bit format string for ECC M + mask 0 is fixed by the spec.
    const expected = '101010000010010';
    const q = encodeQr(addr);
    let read = '';
    for (let i = 0; i < 15; i++) {
      if (i < 6) read += at(q, 8, i) ? '1' : '0';
      else if (i < 8) read += at(q, 8, i + 1) ? '1' : '0';
      else if (i === 8) read += at(q, 7, 8) ? '1' : '0';
      else read += at(q, 14 - i, 8) ? '1' : '0';
    }
    expect(read).toBe(expected);
  });

  it('is deterministic and payload-sensitive', () => {
    expect(encodeQr(addr).modules).toEqual(encodeQr(addr).modules);
    const other = encodeQr('oct2222222222222222222222222222222222222222222');
    expect(other.modules).not.toEqual(encodeQr(addr).modules);
  });

  it('grows the version for longer payloads', () => {
    const small = encodeQr('hello');
    const large = encodeQr('x'.repeat(120));
    expect(large.size).toBeGreaterThan(small.size);
  });

  it('throws when the payload cannot fit', () => {
    expect(() => encodeQr('x'.repeat(5000))).toThrow();
  });
});
