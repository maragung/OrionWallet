import { describe, it, expect } from 'vitest';
import { QUIZ_WORDS, checkQuizAnswers, pickQuizIndexes } from '../../src/wallet/mnemonic-quiz';

const PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('pickQuizIndexes', () => {
  it('picks the requested number of distinct, in-range, sorted indexes', () => {
    for (let run = 0; run < 200; run++) {
      const idx = pickQuizIndexes(12);
      expect(idx).toHaveLength(QUIZ_WORDS);
      expect(new Set(idx).size).toBe(QUIZ_WORDS);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      for (const i of idx) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(12);
      }
    }
  });

  it('never asks for more words than the phrase has', () => {
    expect(pickQuizIndexes(2)).toHaveLength(2);
    expect(pickQuizIndexes(1)).toEqual([0]);
    expect(pickQuizIndexes(0)).toEqual([]);
  });

  it('honours an explicit count', () => {
    expect(pickQuizIndexes(24, 5)).toHaveLength(5);
  });

  it('reaches the high indexes too (no modulo bias toward the start)', () => {
    const seen = new Set<number>();
    for (let run = 0; run < 500; run++) for (const i of pickQuizIndexes(12)) seen.add(i);
    // With 1500 draws over 12 slots, every position should show up.
    expect(seen.size).toBe(12);
  });
});

describe('checkQuizAnswers', () => {
  it('accepts the right words', () => {
    expect(checkQuizAnswers(PHRASE, [0, 5, 11], ['abandon', 'absent', 'accident'])).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(checkQuizAnswers(PHRASE, [0, 5], ['  ABANDON ', 'Absent'])).toBe(true);
  });

  it('rejects a wrong word', () => {
    expect(checkQuizAnswers(PHRASE, [0, 5], ['abandon', 'absorb'])).toBe(false);
  });

  it('rejects blank answers', () => {
    expect(checkQuizAnswers(PHRASE, [0, 5], ['abandon', '   '])).toBe(false);
    expect(checkQuizAnswers(PHRASE, [0], [])).toBe(false);
  });

  it('rejects an out-of-range index rather than passing it', () => {
    expect(checkQuizAnswers(PHRASE, [99], ['abandon'])).toBe(false);
  });

  it('rejects an empty index list — nothing was actually verified', () => {
    expect(checkQuizAnswers(PHRASE, [], [])).toBe(false);
  });

  it('tolerates a phrase with irregular spacing', () => {
    expect(checkQuizAnswers('  alpha   beta\tgamma ', [1, 2], ['beta', 'gamma'])).toBe(true);
  });
});
