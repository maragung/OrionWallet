# Orion Wallet — User Guide

Orion Wallet runs entirely in your browser. Your keys are generated locally, encrypted
with your PIN, and stored only on your own device. Nothing is sent to a server.

> **GitHub:** [github.com/maragung/OrionWallet](https://github.com/maragung/OrionWallet) — Source code, issues, and releases.

---

## Contents

- [Getting started](#getting-started)
- [Creating a wallet](#creating-a-wallet)
- [Importing an existing wallet](#importing-an-existing-wallet)
- [Everyday use](#everyday-use)
- [Encrypted balance (FHE)](#encrypted-balance-fhe)
- [Stealth transfers](#stealth-transfers)
- [Connecting to a dApp](#connecting-to-a-dapp)
- [Locking and unlocking](#locking-and-unlocking)
- [Session expiry](#session-expiry)
- [Backup and recovery](#backup-and-recovery)
- [Troubleshooting](#troubleshooting)
- [Keeping your funds safe](#keeping-your-funds-safe)

---

## Getting started

### Requirements

- A current version of Chrome, Edge, Firefox, or Safari
- JavaScript enabled
- Roughly 4 GB of RAM if you plan to use encrypted-balance features

### Running it

Use a hosted deployment, or run it locally:

```bash
npm install --legacy-peer-deps
npm run dev
```

Then open <http://localhost:5173>.

---

## Creating a wallet

1. Select **Create Wallet**.
2. **Write down your recovery phrase.** You are shown 12 or 24 words. Copy them onto
   paper in the exact order given.
3. Confirm the phrase when prompted.
4. Choose a PIN. This encrypts the wallet on this device.

> **Your recovery phrase is the only way to restore your wallet.** Anyone who has it
> controls your funds. Store it offline. Never photograph it, type it into a website,
> or paste it into a chat or email.

### PIN versus recovery phrase

| | Recovery phrase | PIN |
|---|---|---|
| Purpose | Restores your wallet anywhere | Unlocks it on this device only |
| If lost | Funds are unrecoverable | Restore from the recovery phrase |
| Where stored | Offline, by you | Never stored — only you know it |

---

## Importing an existing wallet

Choose **Import** and pick one of:

- **Recovery phrase** — enter your 12/24 words
- **Private key** — paste a base64 private key
- **Wallet file** — upload an encrypted `.oct` file and enter its PIN

---

## Everyday use

### Checking your balance

The **Balance** tab shows your public balance and, if PVAC is enabled, your encrypted balance.

### Receiving

Open **Receive** to display your address and a QR code. Your address is public and safe
to share.

### Sending

1. Open **Send**.
2. Paste the recipient address (it begins with `oct`).
3. Enter an amount.
4. Review the fee, then confirm with your PIN.

Always verify the first and last characters of the recipient address before confirming.
Transactions cannot be reversed.

### History

**History** lists recent transactions. When the network is unreachable, cached entries
are shown and marked `⚠ Cached`.

---

## Encrypted balance (FHE)

Orion Wallet can hold part of your balance encrypted using fully homomorphic encryption,
so the amount is not publicly visible on-chain.

This is optional. Everything else works whether or not it is enabled.

### Enabling it

Go to **Settings → PVAC**. Two indicators must both be green:

- **WASM Module** — the cryptographic module has loaded
- **Bridge Initialized** — it has been keyed from your wallet seed

If either is not ready, the panel explains the exact cause and the fix.

### Encrypting and decrypting

Use **Encrypt** to move funds between your public and encrypted balances. These
operations are computationally heavy and may take several seconds; a progress dialog
shows each stage.

---

## Stealth transfers

Stealth transfers send funds to a one-time address derived from the recipient's public
key, so the payment is not publicly linkable to their main address.

Open **Stealth**, enter the recipient and amount, and confirm. The recipient claims the
funds from their own Stealth tab.

---

## Connecting to a dApp

When a website requests a connection, a popup appears showing the requesting origin.

Before approving:

- **Check the origin carefully.** Confirm the domain is exactly the site you intended.
- Approve only the permissions you expect.
- "Trust this site" skips future prompts for read-only requests — use it sparingly.

Review and revoke connections at any time under **Settings → Connected Sites**.

---

## Locking and unlocking

Your PIN decrypts the wallet. The decrypted keys then stay available for as long as the
unlock session lasts — you are not asked for the PIN again until it ends.

- **Refreshing the page keeps you unlocked.** The keys are re-sealed for the browser tab
  you are in, so a reload picks the session back up instead of returning you to the PIN
  screen. You will briefly see "Restoring your session…" while that happens.
- **Closing the tab ends the session.** The sealed copy is scoped to that one tab and
  goes away with it, so a new tab or window starts locked.
- **🔒 in the header locks immediately** and destroys the sealed copy — a reload after
  locking asks for the PIN, as it should.
- **Inactivity locks the wallet** after 30 minutes by default, and a single unlock is
  never carried for more than 8 hours regardless of activity.

Neither half of the sealed session is useful alone: the encrypted keys are held by the
tab, while the key that opens them is kept by the browser in a form that no page —
including this one — can read back out.

Under **Settings → Security → Session & Auto-Lock**:

| Setting | Default | What it does |
| --- | --- | --- |
| Stay unlocked after a page refresh | On | Turn off to require the PIN on every reload |
| Auto-lock after inactivity | 30 minutes | 5 / 15 / 30 / 60 minutes, or never (until the tab closes) |

Both apply at once, including to the session you already have open. On a shared or
untrusted computer, turn the first one off and lock the wallet when you step away.

---

## Session expiry

The same windows govern dApp connections, which expire automatically:

- **Idle timeout:** 30 minutes of inactivity
- **Absolute timeout:** 8 hours from connection

When a session expires, the wallet closes the connection and the dApp is notified.
The dApp should then prompt you to reconnect.

### What happens when your session expires

1. The wallet emits a `sessionExpired` event to the dApp.
2. The dApp detects the expired session and shows a "Reconnect" prompt.
3. You click **Connect** to open the wallet popup again.
4. The wallet restores your session and the dApp resumes.

### If a dApp doesn't reconnect automatically

- Click the **Connect** button in the dApp.
- The wallet popup opens — approve the connection.
- Your previous session data is preserved, so you don't need to re-import your wallet.

---

## Backup and recovery

### Exporting

**Settings → Backup → Export** downloads an encrypted `.oct` file. It is protected by
your PIN, but treat it as sensitive.

### Restoring

Use **Import → Wallet file** and supply the PIN in use when the file was exported.

### Multiple accounts

**Settings → Accounts** derives additional accounts from the same recovery phrase. One
phrase restores all of them.

---

## Troubleshooting

### The page is blank or stuck loading

Reload. If it persists, an error card with a **Retry** button should appear. Report the
message shown there.

### Encrypted balance is unavailable

Settings → PVAC shows one of the following:

| Message | Meaning | Fix |
|---|---|---|
| *The WASM module has not been compiled* | `pvac.js` is not being served | Run `npm run build:wasm` |
| *Content-Security-Policy is blocking WebAssembly* | The CSP lacks `'wasm-unsafe-eval'` | Add it to `script-src` in `index.html` |
| *The compiled module is out of date* | The build predates required functions | Rebuild with `npm run build:wasm` |
| *FHE key generation failed* | The module loaded but keying failed | Check the browser console and report it |

Press **↻ Reload PVAC** after applying a fix — no restart needed.

### "Failed to load history" / network errors

Usually the RPC node is unreachable or blocking CORS. Verify the RPC URL under
**Settings**, and see the [CORS notes](../README.md#cors).

### I forgot my PIN

Reinstall the wallet using your recovery phrase and set a new PIN. Without the phrase,
the funds cannot be recovered — by anyone.

### My wallet vanished after an update

Data is migrated automatically from older builds on first launch. If your accounts are
missing, **do not create a new wallet** — that could overwrite the old data. Report the
issue, and restore from your recovery phrase in the meantime.

### dApp says "Session expired"

This means the wallet session timed out (30 min idle / 8h absolute). Reconnect by
clicking **Connect** in the dApp. Your wallet data is preserved — you only need to
re-approve the connection.

---

## Keeping your funds safe

**Do**

- Keep your recovery phrase offline, on paper, ideally in more than one location
- Verify recipient addresses before sending
- Verify the origin shown in dApp connection prompts
- Start with a small test transaction when sending to a new address

**Never**

- Enter your recovery phrase on any website. Orion Wallet will never ask for it after setup
- Store the phrase in a screenshot, password manager note, cloud drive, or chat
- Share your private key or `.oct` file
- Use a wallet holding real funds on a shared or untrusted computer

Orion Wallet has **not been independently audited**. Please review the
[Security document](SECURITY.md) before storing significant value.