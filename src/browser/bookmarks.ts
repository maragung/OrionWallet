/**
 * `oct://` browser bookmarks, persisted in IndexedDB (store `browser-bookmarks`,
 * keyPath `uri`). Bookmarks are non-secret, so they live in the same idb layer
 * as the rest of the wallet's local state (added as an additive v4 store).
 */
import { getDb } from '../wallet/storage';

export interface Bookmark {
  /** Canonical `oct://<circle>/<path>` — primary key. */
  uri: string;
  /** User-facing label (defaults to the circle id / title). */
  title: string;
  createdAt: number;
}

const STORE = 'browser-bookmarks';

/** List all bookmarks, newest first. */
export async function listBookmarks(): Promise<Bookmark[]> {
  const db = await getDb();
  const all = (await db.getAll(STORE)) as Bookmark[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** Add or update a bookmark (keyed by uri). */
export async function addBookmark(uri: string, title: string): Promise<void> {
  const db = await getDb();
  const existing = (await db.get(STORE, uri)) as Bookmark | undefined;
  const bm: Bookmark = {
    uri,
    title: title || uri,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  await db.put(STORE, bm);
}

/** Remove a bookmark by uri. */
export async function removeBookmark(uri: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, uri);
}

/** Whether a uri is bookmarked. */
export async function isBookmarked(uri: string): Promise<boolean> {
  const db = await getDb();
  return (await db.get(STORE, uri)) !== undefined;
}
