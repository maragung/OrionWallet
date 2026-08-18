/**
 * Test setup: polyfills for jsdom environment.
 * - WebCrypto: polyfilled via Node's webcrypto (+ a cross-realm shim, below)
 * - TextEncoder/TextDecoder: native in Node 18+
 * - indexedDB + IDB globals: polyfilled via fake-indexeddb
 */
import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { types } from 'node:util';

/**
 * Hand every SubtleCrypto argument over as a Node-realm buffer.
 *
 * jsdom builds its window in a second JS realm and vitest copies that realm's
 * globals onto `globalThis`, so `new Uint8Array(...)` in app code — and anything
 * jsdom's own `TextEncoder` returns — is a *foreign* typed array to Node. Node's
 * WebCrypto brand-checks each BufferSource against its own realm and, on Node 20,
 * rejects the lot:
 *
 *   TypeError: Failed to execute 'importKey' on 'SubtleCrypto': 2nd argument is
 *   not instance of ArrayBuffer, Buffer, TypedArray, or DataView.
 *
 * Node 22 and newer accept cross-realm views, which is why this only ever showed
 * up on CI (pinned to Node 20) while every developer machine was green — 73 tests
 * across 9 files, all of them crypto paths. A browser has a single realm, so
 * nothing here reflects a defect in the wallet: the shim belongs to the test
 * environment and nowhere else.
 *
 * `node:util`.types answers by internal slot rather than by `instanceof`, so it
 * recognises the foreign views this has to convert.
 */
function toNodeRealm(value: unknown): unknown {
  // Zero-copy: a Node-realm view over the very same memory.
  if (types.isAnyArrayBuffer(value)) return Buffer.from(value as ArrayBuffer);
  if (types.isArrayBufferView(value)) {
    const v = value as ArrayBufferView;
    return Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength);
  }
  // Algorithm dictionaries carry buffers of their own (iv, salt, info,
  // additionalData, counter, label). Only plain objects are rewritten — a
  // CryptoKey has to reach Node untouched or it loses its internal slots.
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = toNodeRealm(v);
      return out;
    }
  }
  return value;
}

type SubtleMethod = (...args: unknown[]) => unknown;

/** Shadow each subtle.* method with one that converts its arguments first. */
function installCrossRealmSubtleShim(subtle: SubtleCrypto): void {
  const methods = [
    'decrypt',
    'deriveBits',
    'deriveKey',
    'digest',
    'encrypt',
    'exportKey',
    'generateKey',
    'importKey',
    'sign',
    'unwrapKey',
    'verify',
    'wrapKey',
  ] as const;
  const target = subtle as unknown as Record<string, SubtleMethod>;
  for (const name of methods) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(subtle, name, {
      value: (...args: unknown[]) => Reflect.apply(original, subtle, args.map(toNodeRealm)),
      writable: true,
      configurable: true,
    });
  }
}

// Polyfill WebCrypto for jsdom
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: false,
  });
}

// Shim whatever `crypto` ended up global — vitest installs Node's webcrypto in
// the jsdom environment itself, so the branch above is usually skipped and
// patching the imported `webcrypto` alone would miss the object under test.
installCrossRealmSubtleShim(globalThis.crypto.subtle);

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
