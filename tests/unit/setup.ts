/**
 * Test setup: polyfills for jsdom environment.
 * - WebCrypto: polyfilled via Node's webcrypto
 * - TextEncoder/TextDecoder: native in Node 18+
 * - indexedDB + IDB globals: polyfilled via fake-indexeddb
 */
import { webcrypto } from 'node:crypto';

// Polyfill WebCrypto for jsdom
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: false,
  });
}

// Polyfill TextEncoder/TextDecoder (Node 18+ has them globally, but jsdom may not)
if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TextEncoder, TextDecoder } = require('util') as typeof import('util');
  Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder });
}

// Polyfill indexedDB + all IDB globals via fake-indexeddb
// The "auto" entry point sets up indexedDB, IDBFactory, IDBDatabase,
// IDBObjectStore, IDBIndex, IDBTransaction, IDBRequest, IDBCursor, IDBKeyRange, etc.
let idbInstalled = false;
async function ensureIndexedDB() {
  if (idbInstalled) return;
  if (typeof globalThis.indexedDB === 'undefined') {
    try {
      await import('fake-indexeddb/auto');
      idbInstalled = true;
    } catch (e) {
      console.warn('fake-indexeddb not available; IDB-dependent tests will fail:', e);
    }
  } else {
    idbInstalled = true;
  }
}

// Ensure on every test run
beforeAll(async () => {
  await ensureIndexedDB();
});
