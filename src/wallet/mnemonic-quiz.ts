/**
 * Recovery-phrase backup check used right after wallet creation.
 *
 * Showing a phrase and taking the user's word for it is how phrases get lost:
 * the wallet is unlockable by PIN on that one device, and unrecoverable
 * everywhere else. Retyping a few words is the cheapest proof that the phrase
 * actually left the screen.
 */
import { randomBytes } from '../crypto/random';

/** How many words the user must retype to prove the phrase was written down. */
export const QUIZ_WORDS = 3;

/**
 * Pick distinct word positions to quiz, uniformly and with a CSPRNG. Rejection
 * sampling keeps the distribution flat — a bare modulo would favour the low
 * indices, which are also the ones a lazy "backup" is most likely to remember.
 */
export function pickQuizIndexes(wordCount: number, howMany: number = QUIZ_WORDS): number[] {
  const n = Math.max(0, Math.floor(wordCount));
  if (n === 0) return [];
  const want = Math.min(howMany, n);
  const picked = new Set<number>();
  const limit = 256 - (256 % n); // discard the biased tail of the byte range
  // Guarded so a pathological RNG cannot spin forever.
  for (let guard = 0; picked.size < want && guard < 1000; guard++) {
    const byte = randomBytes(1)[0];
    if (byte >= limit) continue;
    picked.add(byte % n);
  }
  // Deterministic top-up for the (practically impossible) case the loop bailed.
  for (let i = 0; picked.size < want; i++) picked.add(i);
  return [...picked].sort((a, b) => a - b);
}

/**
 * Check retyped words against the phrase.
 *
 * Case- and whitespace-insensitive: BIP39 words are lowercase ASCII, so a stray
 * capital or a trailing space is a typing artefact, not a wrong word. An empty
 * answer never passes.
 */
export function checkQuizAnswers(
  mnemonic: string,
  indexes: readonly number[],
  answers: readonly string[],
): boolean {
  const words = mnemonic.trim().split(/\s+/);
  if (indexes.length === 0) return false;
  return indexes.every((wordIndex, slot) => {
    const expected = words[wordIndex];
    const given = (answers[slot] ?? '').trim().toLowerCase();
    return !!expected && !!given && given === expected.toLowerCase();
  });
}
