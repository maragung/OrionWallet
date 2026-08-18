# Changelog

All notable changes to Orion Wallet will be documented in this file.

## [Unreleased]

### Added

- **Recovery-phrase backup check at creation** (`src/wallet/mnemonic-quiz.ts`) — creating a wallet no longer opens it. The user must retype **3 words picked at random** (CSPRNG with rejection sampling, so the low indices a lazy backup remembers are not favoured) before the wallet activates. Case- and whitespace-insensitive, retryable, with **Show Phrase Again** — the point is proof the phrase left the screen, not a spelling test.
- **Contacts / address book** (`src/components/AddressBookPanel.tsx`, `contacts` object store) — address, name, optional note, under **Settings → 📇 Contacts**. The Send form offers saved payees in a **📇 Contacts…** picker, labels a pasted address that matches one, and can save a new one inline with **＋ Save to contacts**. A recognised name is a far better address check than reading base58. CSV export included.
- **QR scanning for the recipient** (`src/components/QrScanner.tsx`, `src/wallet/payment-uri.ts`) — **📷 Scan** in the Send form reads a code with the device camera, decoded in-page with `BarcodeDetector` and never uploaded. Parses `octra:<addr>[?amount=]` and a bare address, and prefills the amount when the code carries one. **Receive** can request an amount, encoding the same URI in its QR code; with no amount it stays a bare address for maximum scanner compatibility.
- **Passkey unlock** (`src/wallet/passkey.ts`, `passkey-unlock` object store) — optional biometric/security-key unlock via the WebAuthn **PRF** extension with `userVerification: 'required'`. `sha256("orion-passkey-unlock-v1" || prf)` seals the serialized wallet with AES-256-GCM; only the credential ID, salt, IV and ciphertext are stored, so the record is inert without a verified gesture on that authenticator. **PRF is required, never degraded** — registration throws and stores nothing rather than keeping a readable key. It seals the wallet, not the PIN: exporting keys, revealing the phrase, changing the PIN and deriving accounts all still require the PIN. A stale credential fails closed (record deleted, PIN required); a *dismissed* prompt deliberately keeps the record so a cancelled gesture cannot silently disable the feature.
- **Watch-only accounts** (`src/wallet/watch-only.ts`) — track an address with no keystore, added under **Settings → 👥 Accounts → 👁 Watch Address**. Balance, history and CSV export work; switching to one needs no PIN because there is nothing to decrypt. `assertCanSign` guards the send, encrypt, stealth, contract and dApp-request paths and throws naming both the action and the fix, so the invariant holds at the API boundary rather than in the UI. Fails closed by construction: any secret key that is not a full 64-byte Ed25519 key is refused even without the flag, and the flag survives `serializeWallet`/`deserializeWallet`.
- **CSV export** (`src/utils/csv.ts`) — **⤓** in History exports the loaded rows (time, hash, type, from, to, direction, amount, fee, status); Contacts exports the whole list. Deliberately exports what is on screen rather than re-fetching, so one click cannot become a silent 20k-row download — "Load more" first to widen it. RFC 4180 quoting with CRLF lines, a BOM on the download so spreadsheets read UTF-8 correctly, and a formula-injection guard that prefixes any cell starting with `=`, `+`, `-`, `@`, tab or CR.
- **Plaintext (http) RPC endpoint policy** (`src/wallet/endpoint-policy.ts`) — non-loopback `http://` endpoints now require explicit per-origin consent (`Settings.allowedInsecureOrigins`), with a **Trust `origin`** button and a removable trusted list in **Settings → Network**. One pure function decides, so the store, the UI and the tests cannot disagree. It reports the most fundamental blocker first — mixed content, then CSP, then consent — so the user is never told to fix the allowlist when the browser is the one refusing.
- **Loopback in `connect-src`** — `http://localhost:*`, `http://127.0.0.1:*` and `http://[::1]:*` are allowed outright: that traffic never leaves the machine. Consent is per origin (scheme + host + port), so `http://127.0.0.1.evil.com` is not loopback and trusting one port does not trust another.
- **`VITE_ALLOW_HTTP_ENDPOINTS=1` build flag** (`vite.config.ts`) — appends `http:` to `connect-src` at build time for self-hosters with a plain-http node. A meta-tag CSP cannot be widened at runtime, which is why this is a build flag and not a setting; user consent still applies on top.
- **`Settings.rpcProxyUrl`** — optional proxy the RPC URL is appended to, percent-encoded. The endpoint is then judged by the proxy's scheme, since that is what the browser connects to. Fixes the no-TLS and no-CORS cases; the UI says to run your own, because the proxy sees every request.
- **`⚠️ Insecure RPC` header badge** (`src/components/Layout.tsx`) — shown when the configured endpoint is unusable, and clicking it opens Settings → Network. A blocked endpoint still constructs an `RpcClient` on purpose: refusing to would leave the user unable to reach Settings to fix it.
- **`RpcClient.unreachableHint`** — appends the endpoint verdict to a bare "Failed to fetch", so the error says what to fix. Applied only to a thrown `TypeError`, never to a real server error or a timeout.
- **Unlock session that survives a page reload** (`src/wallet/unlock-session.ts`) — the unlocked wallet is sealed with AES-256-GCM and split across two stores: the ciphertext in `sessionStorage` (scoped to one tab, dropped when it closes) and the key in IndexedDB as a non-extractable `CryptoKey`. Neither half is usable alone. The session rotates on every restore, and `createdAt` is carried through so refreshing cannot extend the absolute cap.
- **Idle auto-lock** (`src/hooks/useAutoLock.ts`) — real user activity (pointer, keyboard, wheel, touch) refreshes the idle window; the wallet locks itself once it elapses, so the 30-minute rule holds in a tab that is never reloaded, not only on refresh.
- **Settings → Security → Session & Auto-Lock** — "Stay unlocked after a page refresh" (`keepUnlocked`) and "Auto-lock after inactivity" (`autoLockMinutes`: 5/15/30/60/never). Both apply to the session already open, not just the next unlock.
- **"Restoring your session…" screen** (`src/components/SessionRestoring.tsx`) — shown while a session is reopened, so a reload no longer flashes the PIN screen on the way back into the wallet.
- **`unlock-session-keys` object store** — IndexedDB `DB_VERSION` 5 (additive migration). Holds only the sealing key; orphans left by a tab that closed without locking are pruned by age.
- **`aesGcmSeal` / `aesGcmOpen` / `generateAesGcmKey`** in `src/crypto/aes.ts` — AES-GCM helpers that accept a `CryptoKey` or raw bytes, so the session works in insecure contexts too (without the non-extractability guarantee).
- **Docs** — "Locking and unlocking" in `docs/USER_GUIDE.md` (what a refresh, a tab close, and 🔒 each do) and "Unlock session" in `docs/SECURITY.md` (what is persisted, the two-halves split, what it does _not_ defend against, and how to opt out). Also in `USER_GUIDE.md`: "Contacts (address book)", "Watch-only accounts", "Unlocking with a passkey", "Network settings" (nodes without HTTPS, the RPC proxy, and what the ⚠️ badge means), the real creation flow with its word check, and troubleshooting for the insecure-RPC badge, the camera, and a missing passkey button. In `SECURITY.md`: "Passkey unlock", "Watch-only accounts", "Plaintext (http) RPC endpoints", the updated CSP listing, three new threat-model rows, and three new contributor invariants.

### Fixed

- **Reloading the page asked for the PIN again mid-session** — the unlocked wallet lived only in the Zustand store, so any refresh dropped it and rendered the unlock screen even seconds after unlocking. The wallet now resumes from the sealed session; the PIN is required only once the session has genuinely ended (explicit lock, tab closed, 30 minutes idle, or the 8-hour cap). `/connect` popups resume the same way instead of re-prompting during a live session.
- **E2E lock button selector** — `tests/e2e/wallet-unlock.spec.ts` and `pvac-auto-load.spec.ts` clicked `button[aria-label="Lock"]`, which never matched the rendered `aria-label="Lock wallet"`.
- **`clearIndexedDB` left the tab's session behind** — the E2E helper now clears `sessionStorage` as well, so a "clean state" reload cannot come back unlocked.
- **Stale transpiled configs came back, and silently froze `vite.config.ts`** — 0.1.0 deleted `vite.config.js` and friends but not the thing that emits them: `tsconfig.node.json` had `composite: true` and no `outDir`, so any `tsc -b` wrote `vite.config.js` next to the `.ts` source, and Vite resolves the `.js` sibling **first**. The regenerated copy predated every config change since, which is how the new CSP build flag appeared to do nothing. Emit for that project now goes to `node_modules/.tmp/tsconfig-node/`, where it cannot shadow a source file.

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
