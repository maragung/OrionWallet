<p align="center">
  <img src="public/logo.png" alt="Orion Wallet" width="80" />
</p>

<h1 align="center">Orion Wallet</h1>

<p align="center">
  A fully client-side wallet for the <strong>Octra Network</strong>, built with React + Vite + TypeScript.
  <br />
  Features FHE (Fully Homomorphic Encryption) support via WebAssembly.
</p>

<p align="center">
  <a href="https://orionwallet.vercel.app">Live App</a> &middot;
  <a href="https://orionwallet.vercel.app/docs">Documentation</a> &middot;
  <a href="https://orionwallet.vercel.app/demo/dapp.html">Demo dApp</a> &middot;
  <a href="CHANGELOG.md">Changelog</a> &middot;
  <a href="docs/SECURITY.md">Security</a>
</p>

---

## Overview

Orion Wallet runs entirely in your browser. There is no backend. Keys are generated, encrypted with your PIN, and stored only on your device — nothing is ever transmitted to a server.

It provides full wallet functionality for the Octra Network: creating and importing wallets, sending and receiving tokens, viewing balances and transaction history, interacting with smart contracts, and connecting to dApps via the SDK.

The wallet also integrates **PVAC** (Privacy-preserving Verified Authenticated Computation), a WebAssembly module that enables encrypted balance checks using fully homomorphic encryption — allowing your balance to be verified without ever being decrypted on-chain.

## Features

- **Non-custodial** — keys never leave your browser
- **BIP-39** mnemonic backup (12 or 24 words)
- **HD wallet** — derive unlimited accounts from a single seed
- **AES-256-GCM** encryption at rest, PIN-protected
- **Send & receive** OCT tokens with real-time balance
- **Transaction history** with block explorer links
- **Stealth transfers** — one-time addresses for recipient privacy
- **Encrypted balance (FHE)** — verify balances without decryption via PVAC/WebAssembly
- **Smart contract interaction** — read state and send transactions with ABI encoding
- **dApp SDK** — connect dApps via `wallet_connect` or `orion_wallet_connect`
- **Session management** — automatic session expiry detection, refresh, and reconnect
- **Multi-language** — English, Indonesian, Arabic, Chinese, Korean, Japanese
- **Dark / light theme**
- **Zero tracking** — no analytics, no telemetry, no cookies

## Quick start

```bash
# Install dependencies
npm install --legacy-peer-deps

# Start development server
npm run dev

# Open in browser
open http://localhost:5173
```

> `--legacy-peer-deps` is required because ESLint 9 and `@eslint/js` 10 declare conflicting peer ranges.

## Project structure

```
src/
  api/            # Wallet API (send, encrypt, balance)
  components/     # React UI components
  connect/        # dApp connection handler and approval UI
  crypto/         # Cryptographic primitives (AES, Ed25519, X25519, BIP-39, etc.)
  hooks/          # React hooks (theme, loading, panel state)
  i18n/           # Translations and i18n provider
  pvac/           # PVAC WebAssembly bridge (FHE encrypted balance)
  rpc/            # JSON-RPC client for Octra nodes
  sdk/            # dApp-facing SDK (WalletProvider, PopupTransport, protocol)
  stealth/        # Stealth address generation
  store/          # Zustand state store + IndexedDB persistence
  styles/         # Global CSS
  tx/             # Transaction builder, ABI, canonical JSON
  utils/          # Clipboard, progress helpers
  wallet/         # Wallet creation, import, PIN, storage

public/
  demo/           # Standalone dApp integration demo (dapp.html)
  docs/           # Static HTML documentation pages
  wasm/           # Compiled PVAC module

tests/
  e2e/            # Playwright end-to-end specs
  unit/           # Vitest unit tests (780+)

docs/
  USER_GUIDE.md   # End-user documentation
  DEVELOPER.md    # Architecture and contributor guide
  SECURITY.md     # Threat model and vulnerability reporting
```

## SDK — dApp Integration

Orion Wallet exposes a JavaScript SDK for dApps to connect and interact with the wallet. It supports both `wallet_*` and `orion_wallet_*` method namespaces.

### Installation

The SDK is not on npm yet. It is served straight from the wallet origin as a self-contained ES module — no build step needed:

```html
<script type="module">
  const { WalletProvider } =
    await import('https://orionwallet.vercel.app/sdk/orion-wallet-sdk.mjs');
</script>
```

### Basic usage

```html
<script type="module">
  const { WalletProvider } =
    await import('https://orionwallet.vercel.app/sdk/orion-wallet-sdk.mjs');

  const provider = new WalletProvider({
    walletUrl: 'https://orionwallet.vercel.app/connect',
    capabilities: [
      'signMessage',
      'signTypedData',
      'approveContract',
      'signContract',
      'multiAccount',
      'events',
      'sessionRestore',
    ],
  });

  // Connect — opens the wallet popup
  const result = await provider.connect();
  console.log(result.address); // Connected address

  // Check session health before signing
  if (!provider.isSessionAlive()) {
    await provider.refreshSession(); // Reopens popup, re-establishes channel
  }

  // Sign a message
  const signature = await provider.signMessage('Hello from my dApp');

  // Sign a contract call (returns signed tx, does NOT broadcast)
  const tx = await provider.signContract({
    program: 'MyContract',
    method: 'transfer',
    args: [recipient, amount],
    ou: '200000',
  });
</script>
```

### Session management

Orion sessions expire after **30 minutes idle** or **8 hours absolute**. The SDK provides built-in session health checks and auto-reconnect:

```javascript
// Check if the session is still alive
if (!provider.isSessionAlive()) {
  // Session expired — refresh to reopen the popup
  await provider.refreshSession();
}

// Listen for session expiry events
provider.on('sessionExpired', () => {
  // Prompt the user to reconnect
  setConnected(false);
});
```

### Event API

| Event            | Payload                | Description                                       |
| ---------------- | ---------------------- | ------------------------------------------------- |
| `connect`        | `ConnectResult`        | Fired after successful connection                 |
| `disconnect`     | `{ reason }`           | Fired when the connection closes                  |
| `accountChanged` | `{ address }`          | Fired when the active account changes             |
| `networkChanged` | `{ network, chainId }` | Fired when the network changes                    |
| `sessionExpired` | `{ origin }`           | Fired when the session expires on the wallet side |

### Method namespaces

The wallet answers to two equivalent namespaces:

| Generic                  | Orion-branded                  | Operation                   |
| ------------------------ | ------------------------------ | --------------------------- |
| `wallet_connect`         | `orion_wallet_connect`         | Initiate connection         |
| `wallet_signMessage`     | `orion_wallet_signMessage`     | Sign a plain message        |
| `wallet_signTypedData`   | `orion_wallet_signTypedData`   | Sign structured data        |
| `wallet_approveContract` | `orion_wallet_approveContract` | Pre-approve a contract call |
| `wallet_signContract`    | `orion_wallet_signContract`    | Sign a contract transaction |
| `wallet_getAccounts`     | `orion_wallet_getAccounts`     | List accounts               |
| `wallet_getBalance`      | `orion_wallet_getBalance`      | Read balance                |

Both namespaces are accepted and execute identically. The `orion_wallet_*` names exist for dApps that want to explicitly target Orion Wallet.

### Prohibited methods

The following methods are blocked locally by the SDK — they can never be used to execute transactions without explicit user approval:

- `wallet_sendTransaction` / `sendTransaction`
- `wallet_broadcastTransaction` / `broadcastTransaction`
- `wallet_transfer` / `transfer`
- `wallet_swap` / `swap`
- `wallet_bridge` / `bridge`

### Security invariants

- **Origin validation** on every inbound `postMessage`
- **Anti-replay:** CSPRNG challenge + dApp nonce + per-session monotonic nonce
- **Permissions** are per-origin, persisted in `sdk-sessions`, and granted/revoked explicitly
- **MessagePort independence:** The port outlives the popup. Once transferred, the wallet can close the approval window without breaking the connection
- **Prohibited methods** are rejected both client-side and wallet-side
- **`localStorage`** holds only a session-restore hint (address, network) — never secrets

## Security

- Keys are encrypted with AES-256-GCM (PIN-derived key via PBKDF2)
- No backend — all crypto runs client-side in the browser
- Per-origin permissions with explicit approval prompts for every signing operation
- CSPRNG challenge/nonce per session prevents message replay
- Content Security Policy restricts script, connect, and frame sources

Orion Wallet has **not undergone an independent security audit**. Please review the [Security documentation](docs/SECURITY.md) and threat model before storing significant value.

### Reporting vulnerabilities

Do not open a public issue. Report privately — see [SECURITY.md](docs/SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code standards, and PR workflow.

## License

[CC BY-NC-SA 4.0](LICENSE) — Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International.

| What you can do                                     | What you cannot do                             |
| --------------------------------------------------- | ---------------------------------------------- |
| Use, study, and audit the source code               | Fork or publish a competing commercial product |
| Use for personal (non-commercial) purposes          | Sell or sublicense this software               |
| Modify and redistribute for non-commercial purposes | Use the Orion Wallet name or trademarks        |
| Run your own node or instance                       | Remove attribution or license notices          |

The source code is open for transparency and security auditing. Any derivative work must use the same CC BY-NC-SA 4.0 license (ShareAlike).
