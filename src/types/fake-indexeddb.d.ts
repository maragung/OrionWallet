/**
 * Type declarations for fake-indexeddb/auto module.
 * The package ships .d.ts files but they're not resolved via package.json exports.
 */
declare module 'fake-indexeddb/auto' {
  // Side-effect import: registers indexedDB + IDB* globals on the host
  // No exports needed; the import itself performs the global setup.
  const _setup: void;
  export default _setup;
}

declare module 'fake-indexeddb' {
  import type { IDBFactory } from 'node:indexeddb';
  const fakeIndexedDB: IDBFactory;
  export default fakeIndexedDB;
}
