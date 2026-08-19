import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Build the dApp-side SDK as a real, shippable artifact.
 *
 * The main build only ever had `index.html` as an input, so `src/sdk/*` was
 * compiled for the wallet's own pages and never emitted as something a dApp
 * could load. That single gap is what forced every integrator to re-implement
 * the wire protocol by hand — reading the popup handshake, the challenge/ack
 * exchange and the nonce rules out of the wallet's source and reproducing them
 * from memory. Reverse-engineered copies then drift, silently, in exactly the
 * places that matter (op_type inside the signed digest; freshness windows;
 * which methods are prohibited).
 *
 * So the SDK gets its own build, emitted alongside the app:
 *
 *   dist/sdk/orion-wallet-sdk.mjs        ESM — `import(…)` from any bundler or
 *                                        straight from a <script type="module">
 *   dist/sdk/orion-wallet-sdk.iife.js    classic script, exposes window.OrionWallet
 *   dist/sdk/types/                      .d.ts (emitted by tsconfig.sdk.json)
 *
 * `emptyOutDir` is off because this runs *after* the main build and must not
 * delete it. The SDK has no runtime dependencies at all (it imports nothing
 * outside `src/sdk`), so there is nothing to externalise and the bundle is
 * fully self-contained.
 */
/**
 * Write the manifest that makes `dist/sdk/` a consumable package.
 *
 * Generated rather than checked in so the version can only ever come from one
 * place. A hand-written copy in `public/sdk/package.json` would be a second
 * version number to forget, and the failure mode of forgetting is an integrator
 * pinning a version that does not describe the code they received.
 */
function sdkManifest(): Plugin {
  return {
    name: 'orion-sdk-manifest',
    apply: 'build',
    closeBundle() {
      const root = fileURLToPath(new URL('.', import.meta.url));
      const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8')) as {
        version: string;
        license: string;
      };
      const manifest = {
        name: '@orion-wallet/sdk',
        version: pkg.version,
        description:
          'dApp-side SDK for the Orion Wallet (Octra Network). Sign-only: the wallet never broadcasts.',
        license: pkg.license,
        type: 'module',
        sideEffects: false,
        main: './orion-wallet-sdk.mjs',
        module: './orion-wallet-sdk.mjs',
        types: './types/index.d.ts',
        unpkg: './orion-wallet-sdk.iife.js',
        exports: {
          '.': {
            types: './types/index.d.ts',
            import: './orion-wallet-sdk.mjs',
            default: './orion-wallet-sdk.iife.js',
          },
        },
      };
      writeFileSync(
        root + 'dist/sdk/package.json',
        JSON.stringify(manifest, null, 2) + '\n',
        'utf8',
      );
    },
  };
}

export default defineConfig({
  plugins: [sdkManifest()],
  // The wallet's `public/` is already copied by the main build. Leaving the
  // default on made this build copy all of it a second time into dist/sdk/,
  // so the demo, the docs and the WASM blobs were each shipped twice.
  publicDir: false,
  build: {
    target: 'es2020',
    outDir: 'dist/sdk',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)),
      name: 'OrionWallet',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'orion-wallet-sdk.mjs' : 'orion-wallet-sdk.iife.js'),
    },
  },
});
