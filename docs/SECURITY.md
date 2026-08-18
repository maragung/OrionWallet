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
| A recovery phrase never actually written down | Creation is gated on retyping 3 random words |
| Signing from an account with no keys | `assertCanSign` refuses at the API boundary, not just in the UI |
| Silently eavesdropped RPC traffic | Plaintext endpoints need explicit per-origin consent |

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

### Unlock session

The PIN is not persisted, but the *result* of unlocking is, for as long as the session lasts:
refreshing the page must not throw the user back to the PIN screen. `src/wallet/unlock-session.ts`
seals the decrypted wallet with AES-256-GCM and splits it across two stores:

| Half | Where | Lifetime |
|---|---|---|
| Ciphertext (`orion:unlock-session`) | `sessionStorage` | One tab. Gone when that tab closes |
| Sealing key | IndexedDB `unlock-session-keys`, as a **non-extractable** `CryptoKey` | Deleted on lock; orphans pruned by age |

Neither half is usable alone. IndexedDB survives a tab closing but holds no ciphertext;
`sessionStorage` holds ciphertext but no key, and a second tab or another origin cannot read
it. The key is generated with `extractable: false`, so it can be *used* by this origin but its
bytes cannot be read out — not by our own code, and not by anything that manages to run in the
page. The session rotates (fresh key, fresh nonce) on every restore, and carries `createdAt`
forward so refreshing cannot extend the absolute cap.

Expiry: **30 minutes idle** (configurable, `autoLockMinutes`; `0` disables it) and an **8-hour
absolute cap** from the original unlock. Both are enforced on restore, and the idle window is
also enforced live by `useAutoLock`, so a tab left open locks itself.

What this does *not* defend against — the honest part:

- **Script execution in the tab.** Code running in the page during a live session can ask the
  browser to decrypt the session and then sign with the keys, exactly as the wallet does. It
  cannot exfiltrate the sealing key, so the compromise ends with the tab; it does not become a
  stolen key usable elsewhere.
- **A compromised device.** Unchanged from the threat model above: local malware can read
  IndexedDB and `sessionStorage` together.
- **Insecure contexts.** Without `crypto.subtle` (plain `http://`, see below), the sealing key
  falls back to raw bytes in IndexedDB and the non-extractability guarantee is lost. The split
  and the expiry still hold.

To opt out entirely, turn off **Settings → Security → Stay unlocked after a page refresh**
(`keepUnlocked: false`). Nothing is written, and every reload asks for the PIN — the behaviour
before this feature existed. An explicit lock (🔒) destroys both halves immediately.

### Passkey unlock

Optional, off by default, and additive: it is a second way to open an existing wallet, never
a replacement for the PIN. `src/wallet/passkey.ts`.

Registration creates a platform credential with `userVerification: 'required'` and the
WebAuthn **PRF** extension. PRF gives the page a secret derived from the credential and a
stored 32-byte salt, which the browser will only produce after the user verifies. The
wallet takes `sha256("orion-passkey-unlock-v1" || prf)` as an AES-256 key, seals the
serialized wallet with AES-256-GCM, zeroes the key, and stores the sealed blob in IndexedDB
next to the credential ID and salt.

| Stored | Not stored |
|---|---|
| Credential ID, PRF salt, IV, ciphertext of the wallet | The PRF output, the derived key, the PIN, any plaintext key material |

Consequences worth stating plainly:

- **PRF is required, never degraded.** If the authenticator does not support it,
  registration throws and stores nothing. The alternative — keeping a readable key
  alongside the ciphertext — would make the record self-decrypting, which is worse than not
  offering the feature.
- **The record is inert on its own.** Without a successful user-verified gesture on that
  authenticator, there is no way to derive the key from what is on disk.
- **It seals the wallet, not the PIN.** The PIN is still the only thing that exports keys,
  reveals the phrase, changes the PIN, or derives an account. Passkey unlock therefore
  cannot be used to escalate to those, and the stored record leaks strictly less than a
  stored PIN would.
- **Same session model as a PIN unlock.** A passkey unlock produces the same unlock session
  with the same idle and absolute caps; it does not extend either.
- **Scoped to the device and browser.** Bound to the origin's `rpId` and stored locally. It
  is not part of a wallet export and is not derived from the recovery phrase.
- **A stale credential fails closed.** If decryption fails — a rotated or re-registered
  credential, a restored device — the record is deleted and the PIN is required. A
  *dismissed or timed-out gesture* deliberately does **not** delete it, so a cancelled
  prompt cannot silently disable the feature.
- **Refused for watch-only accounts.** There is no key material to seal.

What it does not defend against is unchanged: a compromised device, and script execution in
a live session, exactly as for the unlock session above. It does remove one real exposure —
the PIN being typed and observed on every unlock.

### Watch-only accounts

An account can be added by address alone, with no keystore. The invariant is that such an
account can never sign, and it is enforced where the signing happens, not in the UI:
`assertCanSign` (`src/wallet/watch-only.ts`) is called by the send, encrypt, stealth,
contract, and dApp-request paths, and throws naming both the action and the fix.

It fails closed by construction: the check refuses any wallet whose secret key is not a
full 64-byte Ed25519 key, so a truncated or missing key is refused even if the `watchOnly`
flag were somehow lost. The flag is carried through `serializeWallet`/`deserializeWallet`,
so a wallet restored from an unlock session is still watch-only.

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
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*;
frame-src 'self' https:; worker-src 'self' blob:; object-src 'none';
base-uri 'self'; form-action 'self';
```

Three entries deserve explanation:

- **`'wasm-unsafe-eval'`** is required for the PVAC FHE module. Chromium blocks
  `WebAssembly.instantiate()` without it. It permits WebAssembly compilation only — it does
  **not** re-enable JavaScript `eval()`.
- **`'unsafe-inline'` for styles** is needed for the pre-paint critical CSS that avoids a
  flash of unstyled content. It applies to styles only, never to scripts.
- **Loopback in `connect-src`** lets a locally-run node be used without widening the policy
  to plaintext in general. Traffic to `localhost` / `127.0.0.0/8` / `[::1]` never leaves the
  machine, so there is nothing on the wire to intercept.

### Plaintext (http) RPC endpoints

Anything else over plain `http://` is refused by default, and `src/wallet/endpoint-policy.ts`
is the single place that decides. It is a pure function of the URL plus an explicit context,
so the store, the Settings UI and the tests cannot disagree about what is allowed.

Three independent blockers apply, and the verdict names the most fundamental one first so
the user is never told to fix the allowlist when mixed content is the real cause:

| Blocker | Who enforces it | How it is lifted |
|---|---|---|
| Mixed content | The browser, unconditionally | Not liftable. Use TLS or a proxy |
| Content-Security-Policy | The shipped meta-tag CSP | Rebuild with `VITE_ALLOW_HTTP_ENDPOINTS=1` |
| User consent | `allowedInsecureOrigins` in settings | **Trust** the origin in Settings → Network |

Notes on the design:

- The CSP is a meta tag, so it **cannot be widened at runtime** — no setting could grant
  this, which is why it is a build flag. `VITE_ALLOW_HTTP_ENDPOINTS=1` appends `http:` to
  `connect-src` at build time and nothing else; user consent is still required on top.
- Consent is **per origin** — scheme, host and port. It is not a hostname match and not a
  URL prefix, so trusting `http://node.lan:8080` does not trust another port on that host,
  and `http://127.0.0.1.evil.com` is not treated as loopback.
- **Explorer URLs are exempt** because they are only ever `<a href>` navigations, not
  fetches. `connect-src` and mixed content do not apply to them. `relayerUrl` is stored but
  never fetched. Only `rpcUrl` is subject to this policy.
- A blocked endpoint still builds an `RpcClient`, deliberately: refusing to construct one
  would leave the user unable to reach Settings to fix it. The reason surfaces instead as an
  **⚠️ Insecure RPC** badge in the header and as `RpcClient.unreachableHint`, which is
  appended only to a thrown `TypeError` — never to a real server error or a timeout, which
  would be misleading.
- **`rpcProxyUrl`** moves the decision to the proxy: the endpoint is judged by the proxy's
  own scheme, since that is what the browser actually connects to. The proxy sees every
  request, so the UI says to run your own. It cannot reach keys or sign.

Plaintext RPC is a confidentiality *and* integrity exposure — a node on the path can read
every lookup and alter the replies — but not a key-compromise one: signatures are produced
locally and the wallet verifies nothing it receives into key material.

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

### What a dApp learns about a custom network

Networks the user added by hand are visible to connected sites (`wallet_getNetworkInfo`,
`wallet_getNetworks`, and the `networkChanged` event), because a dApp cannot render a correct
explorer link or chain label without knowing which network it is on. The record that crosses
the wire is a deliberate subset:

| Sent | Withheld |
|---|---|
| `id`, `name`, `explorerUrl`, `icon`, `custom` | `rpcUrl`, `relayerUrl` |

The endpoints are withheld because a user-added network is usually a private one — a LAN
address, a tunnel, a paid provider URL with the API key in the query string. Connecting to a
site should not disclose where the user's node lives or hand over a credentialed URL. No
functionality is lost: reads are proxied through the wallet and transactions are built and
broadcast by the wallet, so a dApp never needs to reach the RPC itself.

Two consequences worth knowing:

- A custom network's **name** is user-chosen and is shown to dApps. Naming one after a
  personal identifier discloses that identifier to every site you connect to.
- `wallet_getNetworks` reveals **how many** networks you have configured. This is a small
  fingerprinting surface, accepted so that a dApp can offer "switch to X" guidance.

No dApp can change the network. There is no `wallet_switchNetwork` method; switching happens
only in the wallet's own UI, and the dApp finds out afterwards via `networkChanged`.

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
- Passkey unlock requires PRF; never fall back to storing a readable key
- `assertCanSign` guards every signing path — a watch-only account must never sign
- Plaintext endpoint policy stays in `endpoint-policy.ts`; no ad-hoc URL checks elsewhere
- Canonical JSON stays byte-exact — signatures depend on it

Any change touching crypto, key handling, storage, or the connect flow should say so
explicitly in the pull request.
