# Security

> **GitHub:** [github.com/maragung/OrionWallet](https://github.com/maragung/OrionWallet) — Source code, issues, and releases.
> **Report vulnerabilities:** [GitHub Security Advisories](https://github.com/maragung/OrionWallet/security/advisories/new)

## Audit status

**Orion Wallet has not undergone an independent third-party security audit.**

The cryptographic design follows the reference `octra-labs/webcli` implementation, and the
primitives come from well-reviewed libraries. But the integration itself is unaudited.
Please weigh that before storing significant value.

---

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately to the maintainers, including:

- A description of the issue and its impact
- Steps to reproduce
- Affected version or commit
- Any suggested remediation

Please allow a reasonable window for a fix before public disclosure. Reports are welcome
and credited unless you prefer otherwise.

---

## Threat model

### What Orion Wallet protects against

| Threat | Mitigation |
|---|---|
| Keys leaking to a server | No backend. Keys never leave the browser |
| Keystore theft at rest | AES-256-GCM, key derived from the PIN via PBKDF2 |
| Malicious dApp requests | Per-origin permissions with explicit approval prompts |
| Cross-origin message forgery | Origin validated on every inbound message |
| Message replay | CSPRNG challenge and nonce per session |
| XSS via injected markup | No `innerHTML` / `dangerouslySetInnerHTML`; CSP restricts sources |
| Malformed RPC data crashing the app | Defensive normalisation plus error boundaries |

### What it cannot protect against

Be explicit with yourself about these:

- **A compromised device.** Malware, a keylogger, or a hostile browser extension can read
  the PIN as you type it and extract decrypted keys from memory.
- **A lost recovery phrase.** There is no recovery mechanism. No one can restore it.
- **Phishing.** If you enter your recovery phrase on a fake site, funds are gone. Orion
  Wallet never asks for your phrase after setup.
- **A compromised RPC node.** A malicious node can serve false balances or withhold
  transactions. It cannot forge signatures or steal keys.
- **Supply-chain compromise** of npm dependencies or the hosting provider.
- **Physical access** to an unlocked device with the wallet unlocked.

---

## Cryptographic design

### Key derivation and storage

| Purpose | Algorithm |
|---|---|
| Mnemonic | BIP39 |
| HD derivation | Ed25519, SLIP-0010 style |
| Signing | Ed25519 (tweetnacl) |
| ECDH (stealth) | X25519 (@noble/curves) |
| Keystore encryption | AES-256-GCM (WebCrypto) |
| PIN → key | PBKDF2-HMAC-SHA256 |
| Randomness | `crypto.getRandomValues` |

The keystore format matches the C++ original: `OCT1` magic, version, PBKDF2 iteration
count, salt, nonce, then AES-GCM ciphertext with its authentication tag.

### PIN handling

The PIN is **never persisted**, in any form. It derives the decryption key at unlock time
and is then discarded. There is no "remember my PIN" — by design. Consequently, a forgotten
PIN can only be resolved by restoring from the recovery phrase.

### Randomness

All security-relevant values use `crypto.getRandomValues` via `src/crypto/random.ts`.

`makeId` in `src/sdk/protocol.ts` has a `Math.random` fallback. It is used **only** for
message correlation IDs, never for security values, and is annotated as such. Do not reuse
it for challenges, nonces, keys, or salts.

---

## Browser security posture

### Content-Security-Policy

Set in `index.html`:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https:;
frame-src 'self' https:; worker-src 'self' blob:; object-src 'none';
base-uri 'self'; form-action 'self';
```

Two entries deserve explanation:

- **`'wasm-unsafe-eval'`** is required for the PVAC FHE module. Chromium blocks
  `WebAssembly.instantiate()` without it. It permits WebAssembly compilation only — it does
  **not** re-enable JavaScript `eval()`.
- **`'unsafe-inline'` for styles** is needed for the pre-paint critical CSS that avoids a
  flash of unstyled content. It applies to styles only, never to scripts.

### Cross-origin isolation

COOP/COEP are `same-origin` / `require-corp` application-wide, with `unsafe-none`
overrides on `/connect` so the approval popup can exchange a MessagePort with the opener.
This narrowing is deliberate and limited to that single route.

---

## dApp connection security

When a site requests a connection:

1. The popup shows the requesting origin prominently.
2. The user must explicitly approve; there is no silent connection for a new origin.
3. Approval is scoped to that origin and persisted per-origin.
4. Signing operations always require confirmation, even for trusted sites.

"Trust this site" suppresses prompts for **read-only** requests (balance, accounts,
network) only. It never grants silent signing.

Connections can be reviewed and revoked under **Settings → Connected Sites**.

---

## Dependency status

Production dependencies: **zero known vulnerabilities** (`npm audit --omit=dev`).

Development dependencies carry advisories in vitest, vite, esbuild, and related packages.
Each remaining fix requires a major upgrade (vite 5→8, vitest 2→4) that risks breaking the
build. These packages are build tooling — they are not shipped to users and cannot affect a
deployed wallet.

This is a deliberate trade-off, revisited at each release. Run `npm audit --omit=dev` to
confirm the shipped surface stays clean.

---

## Guidance for users

**Do**

- Keep your recovery phrase offline, on paper, in more than one location
- Verify recipient addresses character by character before sending
- Verify the origin in every dApp connection prompt
- Send a small test amount first when using a new address
- Keep your browser and OS updated

**Never**

- Enter your recovery phrase on any website after setup
- Store the phrase digitally — no screenshots, cloud notes, or chat messages
- Share your private key or `.oct` backup file
- Use a wallet holding real funds on a shared or untrusted computer

---

## For contributors

Security-sensitive invariants that must not be weakened:

- Origin validation on every inbound `postMessage`
- CSPRNG for all security values; `makeId` is not one
- No secrets in `localStorage`, `sessionStorage`, logs, or error messages
- No `innerHTML` or `dangerouslySetInnerHTML`
- The PIN is never persisted
- Canonical JSON stays byte-exact — signatures depend on it

Any change touching crypto, key handling, storage, or the connect flow should say so
explicitly in the pull request.
