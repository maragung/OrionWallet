# Orion Wallet — Developer Guide

> **GitHub:** [github.com/maragung/OrionWallet](https://github.com/maragung/OrionWallet) — Source code, issues, and releases.

## Contents

- [Setup](#setup)
- [Project layout](#project-layout)
- [Architecture](#architecture)
- [Build system](#build-system)
- [The PVAC WASM pipeline](#the-pvac-wasm-pipeline)
- [State management](#state-management)
- [Error handling](#error-handling)
- [Loading states](#loading-states)
- [Storage and migrations](#storage-and-migrations)
- [Wallet SDK](#wallet-sdk)
- [dApp Integration](#dapp-integration)
- [Session management](#session-management)
- [Testing](#testing)
- [Release checklist](#release-checklist)
- [Known issues](#known-issues)

---

## Setup

```bash
npm install --legacy-peer-deps
npm run dev
```

`--legacy-peer-deps` is mandatory: ESLint 9 and `@eslint/js` 10 declare conflicting peer
ranges. `vercel.json` uses the same flag, so CI and local installs match.

Node 20+ is recommended.

---

## Project layout

```
src/
├── api/          High-level operations (wallet-api, send, encrypt)
├── components/   React components, one panel per tab
├── connect/      dApp approval popup (/connect route)
├── crypto/       Primitives: ed25519, x25519, sha256, aes, bip39, hd, base58/64
├── hooks/        useTheme, usePanelLoading
├── i18n/         Translations and the provider
├── pvac/         FHE bridge: stub + WASM implementation
├── rpc/          JSON-RPC client
├── sdk/          Provider injected into dApps + transport
├── stealth/      Stealth address derivation
├── store/        Zustand store
├── tx/           Canonical JSON, signing, ABI helpers
├── utils/        Clipboard, progress reporting
└── wallet/       Keystore, IndexedDB storage, PIN

public/
  demo/           Standalone dApp integration demo (dapp.html)
  docs/           Static HTML documentation pages
  wasm/           Compiled PVAC module (pvac.js + pvac.wasm)

tests/unit/       Vitest
tests/e2e/        Playwright
docs/             This documentation
```

---

## Architecture

Pure client-side; there is no backend. Data flows in one direction:

```
React components  (src/components/)
       │  read state, dispatch actions
       ▼
Zustand store  (src/store/wallet-store.ts)
       │
       ▼
API layer  (src/api/)          ← orchestrates crypto + RPC
       │
       ├──► Crypto core  (src/crypto/)   WebCrypto, tweetnacl, @noble
       ├──► PVAC FHE     (src/pvac/)     WebAssembly
       ├──► Transaction  (src/tx/)       canonical JSON + signing
       └──► RPC client   (src/rpc/)      fetch
                                           │ HTTPS
                                           ▼
                                    Octra RPC node
```

### Design constraints

**Canonical JSON must be byte-exact.** `src/tx/canonical-json.ts` reproduces
`nlohmann::json` key ordering and formatting exactly. Signatures are computed over these
bytes, so any deviation produces a signature the network rejects. Do not "tidy up" this
serializer.

**Naming: product versus protocol.** "Orion Wallet" is the product. `octra_*` RPC methods,
the `oct` address prefix, the `OCT` ticker, and "Octra Network" are protocol identifiers
and must never be renamed.

---

## Build system

TypeScript config files are the **single source of truth**:

- `vite.config.ts`
- `vitest.config.ts`
- `playwright.config.ts`

> **Do not add `.js` siblings for these.** Vite resolves `vite.config.js` ahead of
> `vite.config.ts`. Stale transpiled copies previously shadowed the `.ts` files, so edits
> to the `.ts` configs had no effect. Those three filenames are now in `.gitignore`.
> `eslint.config.js` is genuine flat config and is intentionally kept.

### Headers

COOP/COEP are set to `same-origin` / `require-corp` (reserved for future WASM threading),
with `unsafe-none` overrides on `/connect` so the popup's `postMessage` + MessagePort
transfer works. Dev headers live in `vite.config.ts`; production headers in `vercel.json`.
**Keep the two in sync.**

### Content-Security-Policy

Defined in `index.html`. `script-src` must include `'wasm-unsafe-eval'` — Chromium refuses
`WebAssembly.instantiate()` without it, which is exactly what made the PVAC module fail to
load silently. That directive permits WebAssembly compilation only; it does not re-enable
JavaScript `eval()`.

---

## The PVAC WASM pipeline

### Building

```bash
git clone https://github.com/emscripten-core/emsdk.git /tmp/emsdk
cd /tmp/emsdk && ./emsdk install latest && ./emsdk activate latest
source /tmp/emsdk/emsdk_env.sh

git clone https://github.com/octra-labs/webcli ../webcli-source
python3 scripts/patch-pvac-aes.py ../webcli-source/pvac   # software AES fallback
npm run build:wasm
```

`patch-pvac-aes.py` is required because PVAC hard-`#error`s without hardware AES (AES-NI or
ARM crypto extensions), which WebAssembly does not offer. The patch adds a portable
software implementation that is bit-identical but roughly 5–10× slower. It is additive: the
hardware paths are untouched, and a backup `.hpp.bak` is written.

### Loading

`src/pvac/wasm-bridge.ts` loads the module in three steps:

1. **Probe** — `HEAD` on the glue URL, so "not built" (404) is distinguishable from
   "blocked by CSP". Without this both surface as an identical opaque import failure.
2. **Import** — dynamic `import()` of an absolute URL with `/* @vite-ignore */`. It must be
   absolute: a bare specifier fails to resolve, and `./wasm/pvac.js` resolves against
   `/assets/` and 404s.
3. **Verify** — assert all 13 required `_pvac_*` exports exist before swapping the bridge in.
   Earlier builds omitted the serialization functions, which broke encrypt/decrypt in a way
   the node reported only as "malformed transaction".

Failures are classified as `PvacFailureReason`: `not-built`, `csp-blocked`,
`missing-exports`, `init-failed`, `unknown`. Each maps to a concrete remedy shown in
Settings. The singleton promise is reset on failure so **↻ Reload PVAC** can retry rather
than replaying a cached rejection.

### Memory rules

The C API is manual-memory. Every `_malloc` needs a `_free`; every `serialize_*` returns a
buffer that must be released with `_pvac_free_bytes`. Handles from `keygen`/`enc_*` need
their matching `_pvac_free_*`. Use `try/finally` — see `WasmPvacBridge` for the pattern.

---

## State management

Zustand, in `src/store/wallet-store.ts`. It owns the wallet, RPC client, settings, PVAC
status, toasts, and the global loading flag.

The global loading flag (`isLoading`) drives a full-screen blur overlay and is reserved for
**whole-app transitions only**, such as wallet unlock. Per-panel work must use
`usePanelLoading` instead — see below.

---

## Error handling

`src/components/ErrorBoundary.tsx` wraps every panel in `Layout.tsx`, keyed by the active
tab so a tripped boundary resets on navigation, plus one boundary at the root in `main.tsx`.

This matters more than it looks. `index.html` contains:

```css
#root:empty::before { content: 'Loading Orion Wallet…'; }
```

Without a boundary, any render-time throw makes React 18 unmount the whole tree, `#root`
becomes empty, and that fallback renders — producing a blank white page that appears stuck
loading forever. The boundary keeps the shell alive and shows a retryable error card.

**Consequence:** functions called during render must not throw on malformed input.
`formatAmount` in `src/tx/builder.ts` accepts `unknown` and degrades to a placeholder,
because neither RPC responses nor the local tx cache are schema-validated. Normalise
untrusted rows before rendering them — `HistoryView` shows the pattern.

---

## Loading states

Use `usePanelLoading` (`src/hooks/usePanelLoading.ts`) for panel-scoped work:

```typescript
const panelLoading = usePanelLoading();

await panelLoading.run('Loading history', async () => {
  const data = await fetchSomething();
  if (!panelLoading.isMounted()) return;   // guard late setState
  setData(data);
}, 'Fetching from the network…');
```

Then render `<ProcessingModal open={panelLoading.loading} … dismissible onClose={panelLoading.hide} />`.

Two properties matter: the modal is **dismissible** (work continues in the background, so a
slow network never traps the user), and state writes are gated on `isMounted()` so
navigating away mid-flight cannot leave a modal stuck on screen.

---

## Storage and migrations

IndexedDB via `idb`, database `orion-wallet`, version 2. Stores are declared once in the
`OBJECT_STORES` array in `src/wallet/storage.ts`; add new ones there so creation and
migration stay consistent.

### The rebrand migration

Renaming the database from `webcli-react` would have orphaned every existing wallet, since
IndexedDB scopes data by database name. `migrateLegacyDatabase` copies all stores forward on
first launch. It is:

- **idempotent** — skipped once the target has any wallet
- **non-destructive** — the legacy database is left intact for rollback
- **non-fatal** — failures are logged, never thrown; a migration bug must not block startup

Remember that `clearIndexedDB` in E2E helpers must delete **both** databases, or the
migration copies the legacy data straight back and "clean state" is not clean.

---

## Wallet SDK

`src/sdk/` is the dApp-facing provider; `src/connect/` is the approval popup served at
`/connect`.

### Method namespaces

The wallet answers to two equivalent namespaces:

| Generic | Orion-branded | Operation |
|---|---|---|
| `wallet_connect` | `orion_wallet_connect` | Initiate connection |
| `wallet_signMessage` | `orion_wallet_signMessage` | Sign a plain message |
| `wallet_signTypedData` | `orion_wallet_signTypedData` | Sign structured data |
| `wallet_approveContract` | `orion_wallet_approveContract` | Pre-approve a contract call |
| `wallet_signContract` | `orion_wallet_signContract` | Sign a contract transaction |
| `wallet_getAccounts` | `orion_wallet_getAccounts` | List accounts |
| `wallet_getBalance` | `orion_wallet_getBalance` | Read balance |
| … | … | … |

Both are accepted and execute identically. The `orion_wallet_*` names exist for dApps that
want to explicitly target Orion Wallet; the generic `wallet_*` names remain supported so
that existing integrations keep working.

`canonicalizeMethod` in `src/sdk/protocol.ts` reduces every method name to its canonical
`wallet_*` form before dispatch, so the two namespaces can never drift out of sync.

### Connection lifecycle

**Handshake (once per session):**

1. dApp calls `provider.connect()` → `PopupTransport` opens `/connect?v=1&rid=…&origin=…`
2. Wallet renders `ConnectApp`, user unlocks if needed
3. Wallet sends `hello` + MessagePort over `window.postMessage`, origin-validated
4. dApp echoes `challenge` over the port (anti-replay)
5. `ConnectHandler` verifies ack, serves `CONNECT` RPC → returns address, accounts, network

**After connect:**

- The **popup may close**, but the MessagePort stays open — it is independent of the window
- The session persists in IndexedDB (`sdk-sessions`) with idle + absolute TTL
- Read methods (`getBalance`, `getAccounts`) are session-silent
- Signing methods **always** open a fresh approval prompt

**The fix for "connect works, nothing else does":**

Originally `PopupTransport.isConnected()` checked `popup.closed`, so every call after the
approval window closed failed with "Transport is not connected". Now it checks only the
port, which outlives the popup. The wallet closes the popup after approval, but the
connection stays live.

### Permission model

**Connect-time:** Only read-only scopes (`viewAccounts`, `viewBalance`, `viewNetwork`).

**Signing scopes** (`signMessage`, `signContract`, etc.) are **granted lazily** on first
successful approval. Before the fix, they were absent from `DEFAULT_PERMISSIONS` and the
dispatcher rejected every signing call with `UNAUTHORIZED` before the prompt could appear —
the second root cause of the symptom.

Now:
- Permission check allows ungranted signing scopes to proceed to the approval prompt
- On approval, `grantPermission` persists the scope to the session
- Subsequent calls skip the permission check but **still require approval** — granting a
  scope only records that the user agrees the dApp may ask

Revocation is explicit: `revokePermission` removes the scope from `permissions` and records
it in `deniedPermissions`, which the dispatcher refuses outright.

### Security invariants

Do not weaken these:

- **Origin validation** on every inbound `postMessage` (`PopupTransport.ts`, `rpc-handler.ts`)
- **Anti-replay:** CSPRNG challenge + dApp nonce + per-session monotonic nonce. `makeId` is
  for message correlation only and must never be used as a security value
- **Permissions** are per-origin, persisted in `sdk-sessions`, and granted/revoked explicitly
- **MessagePort independence:** The port outlives the popup. Once transferred, the wallet can
  close the approval window without breaking the connection
- **Prohibited methods** are rejected both client-side (`WalletProvider`) and wallet-side
  (`rpc-handler`), so transaction execution can never escape to the SDK even via the
  low-level `request()` escape hatch
- **`localStorage`** holds only a session-restore hint (address, network) — never secrets

---

## dApp Integration

### Quick start

```javascript
import { WalletProvider } from '@orion-wallet/sdk';

const provider = new WalletProvider({
  walletUrl: 'https://orionwallet.example/connect',
  capabilities: ['signMessage', 'signContract', 'viewAccounts', 'viewBalance'],
});

const result = await provider.connect();
```

### Session management

Orion sessions expire after **30 minutes idle** or **8 hours absolute**. The SDK provides
built-in session health checks and auto-reconnect:

```javascript
// Check session health before every signing operation
if (!provider.isSessionAlive()) {
  await provider.refreshSession();
}

// Listen for session expiry events
provider.on('sessionExpired', () => {
  setConnected(false);
});
```

### Connection flow diagram

```
dApp                          Orion Wallet
  │                              │
  │  provider.connect()          │
  │  ──────────────────────────► │
  │  │  opens popup ───────────► │  User approves
  │  │  hello + MessagePort ◄── │  ──────────────────►
  │  │  challenge echo ────────► │
  │  │  CONNECT RPC ──────────► │  Returns address
  │  │  ◄────────────────────── │
  │  ◄────────────────────────── │
  │                              │
  │  provider.signContract()     │
  │  ──────────────────────────► │  Opens approval prompt
  │  │  signContract RPC ──────► │  User approves
  │  │  ◄────────────────────── │  Returns signed tx
  │  ◄────────────────────────── │
  │                              │
  │  (session expires after      │
  │   30 min idle / 8h absolute) │
  │                              │
  │  provider.isSessionAlive()   │  Returns false
  │  ──────────────────────────► │
  │                              │
  │  provider.refreshSession()   │
  │  ──────────────────────────► │  Reopens popup
  │  │  (reconnects) ◄───────── │
  │  ◄────────────────────────── │
```

### Prohibited methods

The SDK blocks these methods locally before they reach the transport. The wallet also
re-checks server-side, so transaction execution can never escape:

- `wallet_sendTransaction` / `sendTransaction`
- `wallet_broadcastTransaction` / `broadcastTransaction`
- `wallet_transfer` / `transfer`
- `wallet_swap` / `swap`
- `wallet_bridge` / `bridge`

---

## Session management

Orion Wallet sessions are managed automatically by the SDK. Sessions expire after:

- **Idle timeout:** 30 minutes of inactivity
- **Absolute timeout:** 8 hours from connection

The dApp can check session health at any time:

```javascript
if (!provider.isSessionAlive()) {
  await provider.refreshSession();
}
```

When a session expires, the wallet emits a `sessionExpired` event. The dApp should
listen for this event and prompt the user to reconnect:

```javascript
provider.on('sessionExpired', () => {
  // Prompt user to reconnect
  setConnected(false);
});
```

Session restore is handled automatically — the wallet preserves the session hint in
IndexedDB, so reconnecting after expiry does not require the user to re-import their wallet.

---

## Testing

```bash
npm test                 # 350 unit tests, 30 files
npm run test:coverage    # V8 coverage, 60% threshold
npm run test:e2e         # 7 Playwright specs (needs npm run build first)
npm run autofix          # typecheck → format → lint --fix → test → build
npm run check            # same, read-only (CI)
```

Unit tests run under jsdom with `fake-indexeddb`. Component tests use
`renderToStaticMarkup` rather than a DOM testing library — see
`tests/unit/processing-modal.test.tsx`.

When fixing a bug, add a test that documents the failure mode, not just the fix.
`tests/unit/history-view.test.ts` and `error-boundary.test.tsx` follow this: each names the
symptom it prevents from recurring.

---

## Release checklist

1. `npm run autofix` — must be fully green
2. `npm run test:e2e` against a fresh `npm run build`
3. `npm audit --omit=dev` — production must report zero vulnerabilities
4. Verify PVAC loads in a production preview (`npm run preview`), not just dev
5. Test the migration path from a pre-rebrand build with existing wallet data
6. Confirm `vite.config.ts` server headers still match `vercel.json`

---

## Known issues

**Dev-dependency advisories.** `npm audit` reports vulnerabilities in vitest, vite, esbuild,
and related packages. Every remaining fix needs a major upgrade (vite 5→8, vitest 2→4).
These are build-tooling only and do not ship to users; production audits clean. See
[SECURITY.md](SECURITY.md#dependency-status).

**`storage.ts` chunking warning.** The build warns that `storage.ts` is both statically and
dynamically imported, so it cannot be split into its own chunk. Harmless, but it does mean
the dynamic imports in `HistoryView` and `WalletExportImport` provide no code-splitting
benefit.

**Software AES performance.** The WASM AES fallback is 5–10× slower than native. Heavy PVAC
operations block the main thread; moving them into a Web Worker is the logical next step.