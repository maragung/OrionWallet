<p align="center">
  <img src="public/icons/wallet.svg" alt="Orion Wallet" width="80" />
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
- **dApp SDK** — connect dApps via `orion_wallet_connect` or `wallet_connect`
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

tests/
  e2e/            # Playwright end-to-end specs
  unit/           # Vitest unit tests (350+)

docs/
  USER_GUIDE.md   # End-user documentation
  DEVELOPER.md    # Architecture and contributor guide
  SECURITY.md     # Threat model and vulnerability reporting
```

## Testing

```bash
npm test              # Run all unit tests
npm run test:e2e      # Run Playwright end-to-end tests
npm run autofix       # Full pipeline: typecheck → format → lint → test → build
```

## SDK

Orion Wallet exposes a JavaScript SDK for dApps to connect and interact with the wallet. It supports both `wallet_*` and `orion_wallet_*` method namespaces.

```html
<script type="module">
  import { OrionWalletProvider } from './src/sdk/index.ts';

  const provider = new OrionWalletProvider({ walletUrl: '/connect' });
  const result = await provider.connect();
  console.log(result.address); // Connected address

  const signature = await provider.request({ method: 'wallet_signMessage', params: { message: 'Hello' } });
</script>
```

See [docs/DEVELOPER.md](docs/DEVELOPER.md) for the full SDK reference.

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

GPL-2.0-only — see [package.json](package.json).
