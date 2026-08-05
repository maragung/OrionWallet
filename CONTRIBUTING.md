# Contributing to Orion Wallet

Thanks for your interest in contributing.

---

## Getting set up

```bash
npm install --legacy-peer-deps
npm run dev
```

`--legacy-peer-deps` is required — ESLint 9 and `@eslint/js` 10 declare conflicting peer
ranges.

Read the [Developer Guide](docs/DEVELOPER.md) before your first change. It documents
several non-obvious constraints that are easy to break.

---

## Workflow

1. Create a branch from `main`.
2. Make your change.
3. Run `npm run autofix` until it is fully green.
4. Add tests covering the behaviour you changed.
5. Open a pull request describing what and why.

---

## Before you open a PR

```bash
npm run autofix     # typecheck → format → lint --fix → test → build
```

All six stages must pass. If your change touches the UI, also run:

```bash
npm run build && npm run test:e2e
```

---

## Code standards

- **TypeScript strict mode.** No `any` unless genuinely unavoidable, with a comment saying why.
- **Formatting** is handled by Prettier via `npm run autofix`. Don't hand-format.
- **Comments explain _why_, not _what_.** The code already says what it does. Document the
  constraint, the trade-off, or the bug that made the code look this way.
- **No `console.log` in committed code.** `console.error` / `console.warn` are fine for
  genuine diagnostics.

---

## Things that will break if you're not careful

These have caused real bugs. Please read them.

**Canonical JSON must stay byte-exact.** `src/tx/canonical-json.ts` reproduces
`nlohmann::json` output exactly. Signatures are computed over those bytes. Reformatting it
produces signatures the network silently rejects.

**Don't add `.js` siblings for the Vite/Vitest/Playwright configs.** Vite resolves
`vite.config.js` before `vite.config.ts`. Stale transpiled copies previously shadowed the
`.ts` files so config edits had no effect. Those names are `.gitignore`d.
`eslint.config.js` is genuine flat config and stays.

**Render paths must not throw.** Every panel is wrapped in an error boundary, but a throw
still blanks that panel. RPC responses and the tx cache are not schema-validated — normalise
untrusted data before rendering. See `formatAmount` and `HistoryView`.

**Use `usePanelLoading`, not the global `setLoading`.** The global flag drives a
full-screen blocking overlay and is reserved for whole-app transitions such as unlock.
Panel work uses the dismissible modal so a slow network can't trap the user.

**Product name versus protocol identifiers.** "Orion Wallet" is the product. `octra_*` RPC
methods, the `oct` address prefix, the `OCT` ticker, and "Octra Network" are protocol
identifiers — renaming them breaks compatibility.

**Adding an IndexedDB store?** Declare it in the `OBJECT_STORES` array in
`src/wallet/storage.ts` so creation and migration stay in sync, and bump `DB_VERSION`.

---

## Testing expectations

- New features need tests.
- Bug fixes need a test that documents the failure mode, so it can't silently return.
  `tests/unit/error-boundary.test.tsx` and `history-view.test.ts` show the style: each names
  the symptom it prevents.
- Unit tests go in `tests/unit/`, E2E in `tests/e2e/`.

---

## Security-sensitive changes

If your change touches cryptography, key handling, storage, or the dApp connect flow, say so
explicitly in the PR description so it gets closer review.

Never weaken these invariants:

- Origin validation on inbound `postMessage`
- CSPRNG for all security values
- No secrets in `localStorage`, logs, or error messages
- The PIN is never persisted

Found a vulnerability? **Don't open a public issue** — see
[reporting instructions](docs/SECURITY.md#reporting-a-vulnerability).

---

## Pull request checklist

- [ ] `npm run autofix` passes fully
- [ ] Tests added for the change
- [ ] Comments explain reasoning where the code is non-obvious
- [ ] No secrets, keys, or personal data in the diff
- [ ] Docs updated if behaviour changed
- [ ] Security-sensitive changes flagged in the description

---

## License

Contributions are licensed under GPL-2.0-only, inherited from the original
[`octra-labs/webcli`](https://github.com/octra-labs/webcli).
