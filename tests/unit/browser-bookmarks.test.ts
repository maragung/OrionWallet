import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { wipeEverything, closeDb } from '../../src/wallet/storage';
import {
  listBookmarks,
  addBookmark,
  removeBookmark,
  isBookmarked,
} from '../../src/browser/bookmarks';

describe('browser bookmarks (IndexedDB store)', () => {
  beforeAll(async () => {
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    await wipeEverything();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('starts empty', async () => {
    expect(await listBookmarks()).toEqual([]);
  });

  it('adds, detects, and lists a bookmark', async () => {
    await addBookmark('oct://octABC/index.html', 'Circle A');
    expect(await isBookmarked('oct://octABC/index.html')).toBe(true);
    const all = await listBookmarks();
    expect(all.length).toBe(1);
    expect(all[0]!.title).toBe('Circle A');
  });

  it('is idempotent on the same uri (keyed by uri)', async () => {
    await addBookmark('oct://octABC/index.html', 'First');
    await addBookmark('oct://octABC/index.html', 'Second');
    const all = await listBookmarks();
    expect(all.length).toBe(1);
    expect(all[0]!.title).toBe('Second');
  });

  it('removes a bookmark', async () => {
    await addBookmark('oct://octABC/index.html', 'X');
    await removeBookmark('oct://octABC/index.html');
    expect(await isBookmarked('oct://octABC/index.html')).toBe(false);
    expect(await listBookmarks()).toEqual([]);
  });

  it('sorts newest first', async () => {
    await addBookmark('oct://one/index.html', 'One');
    await new Promise((r) => setTimeout(r, 2));
    await addBookmark('oct://two/index.html', 'Two');
    const all = await listBookmarks();
    expect(all[0]!.uri).toBe('oct://two/index.html');
    expect(all[1]!.uri).toBe('oct://one/index.html');
  });
});
