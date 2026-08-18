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
- [Contacts (address book)](#contacts-address-book)
- [Watch-only accounts](#watch-only-accounts)
- [Encrypted balance (FHE)](#encrypted-balance-fhe)
- [Stealth transfers](#stealth-transfers)
- [Connecting to a dApp](#connecting-to-a-dapp)
- [Locking and unlocking](#locking-and-unlocking)
- [Session expiry](#session-expiry)
- [Network settings](#network-settings)
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

1. Select **Create New Wallet**, name the account, and choose a PIN. The PIN encrypts
   the wallet on this device.
2. **Write down your recovery phrase.** You are shown 12 words. Copy them onto paper in
   the exact order given.
3. Select **I've Written It Down**. The wallet then asks you to retype **3 of the words**,
   picked at random, to prove the phrase actually left the screen. **Show Phrase Again**
   brings it back if you need another look; a wrong answer just lets you retry.
4. Once the words check out, the wallet opens.

> **Creating the wallet does not open it — passing the word check does.** Until then you
> can still walk away, and nothing is lost, because the phrase has not been relied on yet.

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

You can also **request a specific amount**. The QR code then carries the amount alongside
the address (as `octra:<address>?amount=<OCT>`), so a wallet scanning it prefills both.
With no amount requested, the code stays a bare address, which any scanner can read.

### Sending

1. Open **Send**.
2. Give the recipient in whichever way suits you:
   - Paste the address (it begins with `oct`).
   - Pick a saved name from **📇 Contacts…**.
   - Select **📷 Scan** to read a QR code with your camera. The browser asks for camera
     permission the first time; the picture is processed in the page and never uploaded.
     Scanning a code that carries an amount fills the amount in too.
3. Enter an amount.
4. Review the fee and the nonce, then confirm with your PIN.

When the address matches a saved contact, the form shows the name next to it — a name you
recognise is a much better check than a string of base58. For a new address, **＋ Save to
contacts** stores it under a label you choose, so the next payment is a pick, not a paste.

Always verify the first and last characters of the recipient address before confirming.
Transactions cannot be reversed.

### History

**History** lists recent transactions. When the network is unreachable, cached entries
are shown and marked `⚠ Cached`.

**⤓** exports the table to a CSV file (time, hash, type, from, to, direction, amount, fee,
status) for a spreadsheet or your own records. It exports **the rows currently loaded** —
what you see is what you get — so use **Load more** first if you want a longer range. The
file is written by your browser to your downloads folder; nothing is sent anywhere.

---

## Contacts (address book)

**Settings → 📇 Contacts** keeps a list of addresses under names you choose. Each entry has
an address, a name, and an optional note — a good place for "memo required" or which
exchange a deposit address belongs to.

Why bother: an address you cannot read is an address you cannot check. Once a payee is
saved, the Send form offers them by name and labels the address when you paste it back, so
a swapped or truncated address stands out instead of blending in.

- **Add** an entry here, or use **＋ Save to contacts** straight from the Send form.
- **✎** renames an entry, **🗑** removes it. Removing a contact affects nothing on-chain.
- **⤓** exports the list as CSV, so it can be kept with your other records or moved to
  another browser.

Contacts live in this browser only, alongside the rest of your wallet data. They are not
uploaded, and they are wiped with everything else if you clear the wallet.

---

## Watch-only accounts

A watch-only account tracks an address you do **not** hold the keys for — cold storage, a
hardware wallet, an exchange deposit address, someone else's address you keep an eye on.

Add one under **Settings → 👥 Accounts → 👁 Watch Address**: paste the address, give it a
name, and it joins your account list.

What it can do: show the balance, list history, export CSV, and be switched to without a
PIN — there is no keystore to decrypt, so there is nothing to unlock.

What it cannot do: **sign anything.** Send, encrypt/decrypt, stealth transfers, contract
calls, and dApp signing requests all refuse, and the Send form says so before you fill it
in rather than after. Watch-only accounts are marked 👁 in the account list and in the
header, so you always know which kind you are looking at.

To turn a watch-only account into a real one, import the recovery phrase or private key for
that address. Adding the keys is the only way; there is no shortcut.

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

### Unlocking with a passkey

If your device has a fingerprint reader, Face ID, Windows Hello, or a security key, you can
unlock with that instead of typing the PIN.

Turn it on under **Settings → 🔑 Security → Passkey Unlock → Enable passkey unlock**. Your
device prompts you to register — it may prompt **twice**, once to create the passkey and
once to use it. The unlock screen then offers **👆 Unlock with passkey** above the PIN box.

Worth knowing:

- **The PIN still exists and still matters.** The passkey opens the wallet; it does not
  replace the PIN. Exporting keys, revealing the recovery phrase, changing the PIN, and
  deriving new accounts all still ask for it. Keep the PIN — losing it is not fixed by
  having a passkey.
- **It is tied to this device and this browser.** Passkeys do not travel with your wallet
  data. On another device, unlock with the PIN and register a passkey there if you want one.
- **Your fingerprint never reaches the wallet.** The device verifies you locally and hands
  the page a secret derived from the passkey; that secret is what opens the wallet.
- **Availability depends on your device and browser.** If yours cannot do what this needs,
  the Security panel says so and the option stays off — the PIN keeps working exactly as
  before.
- **Turn off passkey unlock** in the same panel. That deletes the stored copy immediately;
  it does not delete the passkey from your device, which you can remove in your OS or
  browser settings.

If a passkey ever stops opening the wallet — a rotated or re-registered credential, or a
restored device — the wallet says so, discards the stale copy, and asks for the PIN. Nothing
is lost; you can register a fresh passkey afterwards.

Passkey unlock cannot be registered while a watch-only account is active — it holds no keys,
so there is nothing for a passkey to seal. The Security panel says so in place of the button.

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

## Network settings

**Settings → ⚙️ General** holds the RPC URL the wallet talks to, the explorer it links out
to, and an optional proxy. Change the RPC URL and select **Save URLs** to point the wallet
at a different node.

### Nodes without HTTPS

An `https://` node needs no special handling. A node reachable only over plain `http://` is
a different matter, because everything the wallet asks it — every balance and history
lookup, every transaction it submits — travels in the clear, where anyone on the network
path can read it *and change the answers*. So the wallet asks first.

- **Loopback needs no permission.** `localhost`, `127.0.0.1`, `[::1]` and friends never
  leave your machine, so a local node works out of the box.
- **Any other `http://` address must be trusted explicitly.** Paste the URL and the panel
  explains what is at stake with a **Trust `http://…`** button next to it. Trust is stored
  per origin (scheme, host, and port), so trusting one node does not trust another, and a
  different port on the same host is a separate decision.
- **Trusted plaintext endpoints** lists what you have trusted, with **Remove** to take it
  back.

Two limits are not ours to lift, and the panel names whichever one is in the way:

- **A wallet served over `https://` cannot fetch `http://` at all.** Browsers block that
  (it is called mixed content), and trusting the origin will not change it. Put the node
  behind TLS, use a proxy, or open the wallet from a plain-http or localhost build.
- **The shipped build allows only `https://` and loopback.** Its security policy is fixed
  at build time and cannot be widened while running. Self-hosters who need plain http can
  build with `VITE_ALLOW_HTTP_ENDPOINTS=1`; the trust list above still applies on top.

The explorer URL is exempt from all of this — it is only ever a link you click, not
something the wallet fetches.

### RPC proxy

**RPC proxy (optional)** routes calls through a URL of your choosing: the RPC URL is
appended to it, percent-encoded, and the browser only ever connects to the proxy. It is the
practical fix for a node with no TLS or no CORS headers, and it satisfies the rules above
because the connection the browser makes is to the proxy.

The proxy sees every request the wallet makes, so **run your own**. It cannot sign anything
or reach your keys, but it can watch and it can lie.

### When something is off

If the RPC endpoint cannot be used as configured, **⚠️ Insecure RPC** appears in the header;
select it to jump straight to the setting. Network errors also carry the reason, so a bare
"Failed to fetch" tells you what to fix.

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

Two things the phrase does **not** restore, because they were never derived from it:

- **Watch-only accounts** — they are just addresses you asked the wallet to track. Note them
  down separately if you want them back after a reinstall.
- **Contacts** — export them with **⤓** under Settings → Contacts if they matter to you.

Neither holds funds, so losing them costs you convenience, not money.

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
**Settings**, and see the [CORS notes](../README.md#cors). If the error names a reason —
plaintext, mixed content, or a build restriction — see
[Network settings](#network-settings); an **RPC proxy** fixes the CORS case.

### The header shows "⚠️ Insecure RPC"

The configured RPC endpoint is plain `http://` and is not usable as it stands. Select the
badge to open the setting, where the exact cause and the fix are spelled out. See
[Network settings](#network-settings).

### The camera won't open when I select 📷 Scan

- Grant the camera permission when the browser asks; if you dismissed it, re-allow it in
  the site permissions and try again.
- Camera access needs a secure page. It works on `https://` and on `localhost`, but not on
  a plain-`http://` page on another host.
- If another app holds the camera, close it first. You can always paste the address instead.

### "Unlock with passkey" isn't offered

Either no passkey is registered in this browser, or the device cannot do what passkey unlock
requires. **Settings → 🔑 Security → Passkey Unlock** says which. Passkeys are per device
and per browser, so one registered elsewhere does not appear here. The PIN always works.

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
- Save payees as contacts, and check the name — a name you recognise beats reading base58
- Use a watch-only account to keep an eye on cold storage, instead of unlocking the real one

**Never**

- Enter your recovery phrase on any website. Orion Wallet will never ask for it after setup
- Store the phrase in a screenshot, password manager note, cloud drive, or chat
- Share your private key or `.oct` file
- Use a wallet holding real funds on a shared or untrusted computer

Orion Wallet has **not been independently audited**. Please review the
[Security document](SECURITY.md) before storing significant value.