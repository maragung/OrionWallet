# Changelog

All notable changes to Orion Wallet will be documented in this file.

## [Unreleased]

### Added

- **Unlock session that survives a page reload** (`src/wallet/unlock-session.ts`) — the unlocked wallet is sealed with AES-256-GCM and split across two stores: the ciphertext in `sessionStorage` (scoped to one tab, dropped when it closes) and the key in IndexedDB as a non-extractable `CryptoKey`. Neither half is usable alone. The session rotates on every restore, and `createdAt` is carried through so refreshing cannot extend the absolute cap.
- **Idle auto-lock** (`src/hooks/useAutoLock.ts`) — real user activity (pointer, keyboard, wheel, touch) refreshes the idle window; the wallet locks itself once it elapses, so the 30-minute rule holds in a tab that is never reloaded, not only on refresh.
- **Settings → Security → Session & Auto-Lock** — "Stay unlocked after a page refresh" (`keepUnlocked`) and "Auto-lock after inactivity" (`autoLockMinutes`: 5/15/30/60/never). Both apply to the session already open, not just the next unlock.
- **"Restoring your session…" screen** (`src/components/SessionRestoring.tsx`) — shown while a session is reopened, so a reload no longer flashes the PIN screen on the way back into the wallet.
- **`unlock-session-keys` object store** — IndexedDB `DB_VERSION` 5 (additive migration). Holds only the sealing key; orphans left by a tab that closed without locking are pruned by age.
- **`aesGcmSeal` / `aesGcmOpen` / `generateAesGcmKey`** in `src/crypto/aes.ts` — AES-GCM helpers that accept a `CryptoKey` or raw bytes, so the session works in insecure contexts too (without the non-extractability guarantee).
- **Docs** — "Locking and unlocking" in `docs/USER_GUIDE.md` (what a refresh, a tab close, and 🔒 each do) and "Unlock session" in `docs/SECURITY.md` (what is persisted, the two-halves split, what it does _not_ defend against, and how to opt out).

### Fixed

- **Reloading the page asked for the PIN again mid-session** — the unlocked wallet lived only in the Zustand store, so any refresh dropped it and rendered the unlock screen even seconds after unlocking. The wallet now resumes from the sealed session; the PIN is required only once the session has genuinely ended (explicit lock, tab closed, 30 minutes idle, or the 8-hour cap). `/connect` popups resume the same way instead of re-prompting during a live session.
- **E2E lock button selector** — `tests/e2e/wallet-unlock.spec.ts` and `pvac-auto-load.spec.ts` clicked `button[aria-label="Lock"]`, which never matched the rendered `aria-label="Lock wallet"`.
- **`clearIndexedDB` left the tab's session behind** — the E2E helper now clears `sessionStorage` as well, so a "clean state" reload cannot come back unlocked.

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
