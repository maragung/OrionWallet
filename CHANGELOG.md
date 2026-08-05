# Changelog

All notable changes to Orion Wallet will be documented in this file.

## [0.1.0] — 2026-08-05

### Added

- **dApp SDK with dual namespace support** — `wallet_*` and `orion_wallet_*` method names are both accepted. `canonicalizeMethod()` maps `orion_wallet_*` to `wallet_*` before dispatch, so the two namespaces stay in sync automatically.
- **Lazy signing permission grant** — signing scopes (`signMessage`, `signTypedData`, `approveContract`, `signContract`) are no longer rejected with `UNAUTHORIZED` before the approval prompt appears. The permission check now allows signing requests through to the approval dialog; scopes are granted on first successful approval.
- **Explicit permission revocation** — `revokePermission()` records revoked scopes in `deniedPermissions`, which the dispatcher refuses outright. This avoids the ambiguity of "absent" vs "revoked".
- **Persistent SDK transport** — `PopupTransport` no longer checks `popup.closed` to determine port status. The MessagePort outlives the approval popup, so the connection stays live after the user approves and the window closes.
- **Docs link on unlock screen** — "Documentation" link at the bottom of the "Welcome Back" card, opening `https://orionwallet.vercel.app/docs` in a new tab.
- **Docs page** — served as static markdown from `/docs` via Vercel, with proper rewrite rules to exclude docs paths from the SPA catch-all.
- **PVAC error classification** — `PvacLoadError` class with typed failure reasons (`not-built`, `csp-blocked`, `missing-exports`, `init-failed`, `unknown`) and remedies shown in the Settings panel.
- **Preflight probe** — `loadPvacModule()` now issues a `HEAD` request before loading the WASM to distinguish "never built" from "CSP blocked".
- **Storage migration** — `migrateLegacyDatabase()` handles the `webcli-react` → `orion-wallet` IndexedDB name change automatically (idempotent, non-destructive).
- **ErrorBoundary** — wraps each panel in `Layout.tsx` and the root in `main.tsx` so a rendering error in one panel doesn't crash the whole wallet.
- **PanelSkeleton** fallback — panels render a loading skeleton instead of a blank screen before the wallet store is ready.
- **Defensive `formatAmount()`** — accepts `null`, `undefined`, `number`, `bigint`, and non-numeric strings without crashing.
- **`normalizeEntry()` in HistoryView** — safely renders malformed cache data without throwing.
- **User Guide** (`docs/USER_GUIDE.md`) — install, create/import wallet, send & receive, encrypted balance, stealth transfers, troubleshooting.
- **Developer Guide** (`docs/DEVELOPER.md`) — architecture, SDK reference, WASM pipeline, testing, release process.
- **Security documentation** (`docs/SECURITY.md`) — threat model, key handling, vulnerability reporting.
- **Contributing guide** (`CONTRIBUTING.md`) — workflow, code standards, PR checklist.
- **This changelog.**

### Fixed

- **"Connect works, nothing else does" root cause #1** — `PopupTransport.isConnected()` checked `popup.closed`, so the port was considered dead after the approval window closed. Now it checks only the port.
- **"Connect works, nothing else does" root cause #2** — `DEFAULT_PERMISSIONS` lacked signing scopes, so the dispatcher rejected every signing call with `UNAUTHORIZED` before the approval prompt could appear. Signing scopes are now granted lazily on approval.
- **`WalletProvider.request()` CONNECT guard** — now uses `canonicalizeMethod()` to check the method name, so `orion_wallet_connect` is recognized as a connect call.
- **Denylist bypass via namespace alias** — prohibited methods like `sendTransaction` are now checked both in their raw form and after canonicalization, so `orion_wallet_sendTransaction` is also rejected.
- **CSP `wasm-unsafe-eval`** — added to `script-src` in `index.html` so the PVAC WASM module can compile.
- **CSP `worker-src blob:`** — added to allow the PVAC module to create web workers.
- **Silent PVAC load failure** — `loadPvacModule()` now logs the error cause instead of swallowing it. The Settings panel shows diagnosis and remedy instead of a generic "not found" message.
- **`closeWatch` killing connection** — removed the `closeWatch` that terminated the port when the popup closed during handshake. The port now stays alive after approval.
- **Stale transpiled config files** — `vite.config.js`, `vitest.config.js`, `playwright.config.js` deleted; `.ts` files are the single source of truth. Added to `.gitignore`.

### Changed

- **Rebranding** — `Octra WebCLI` → `Orion Wallet` across `index.html`, `Layout.tsx`, `main.tsx`, `global.css`, `package.json`, CORS proxy, health check script, and test comments.
- **Panel loading** — replaced global `setLoading` with panel-scoped `usePanelLoading` hook in 8 panels (History, Circles, ContractPanel, ContractViewer, Settings, AccountPicker, AccountSwitcher, WalletExportImport).
- **`ProcessingModal`** — now dismissible and non-blocking; added to all 8 migrated panels.
- **IndexedDB store management** — `OBJECT_STORES` array is the single source of truth; `wipeEverything()` is driven by the array.
- **`clearIndexedDB` in E2E helpers** — now deletes both `webcli-react` and `orion-wallet` databases.
- **`npm audit fix --legacy-peer-deps`** — resolved `brace-expansion` HIGH vulnerability; remaining dev-only advisories documented in SECURITY.md.
