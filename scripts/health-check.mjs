#!/usr/bin/env node
/**
 * Health check script — verifies that all dev tools are installed and working.
 * Run after `npm install` to confirm the toolchain is ready.
 *
 * Usage: node scripts/health-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolvePath(__dirname, '..');

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function run(bin, args) {
  return new Promise((resolve) => {
    const localBin = join(root, 'node_modules/.bin', bin);
    const cmd = existsSync(localBin) ? localBin : bin;
    const p = spawn(cmd, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => (out += d.toString()));
    p.stderr?.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code: code ?? 0, out, err }));
    p.on('error', () => resolve({ code: 1, out: '', err: 'binary not found' }));
  });
}

const checks = [
  {
    name: 'Node.js version',
    run: async () => {
      const r = await run('node', ['--version']);
      const v = r.out.trim();
      const major = parseInt(v.slice(1), 10);
      return {
        ok: major >= 18,
        info: `v${major} (${v})`,
        hint: major < 18 ? 'Node 18+ required' : undefined,
      };
    },
  },
  {
    name: 'npm version',
    run: async () => {
      const r = await run('npm', ['--version']);
      return { ok: r.code === 0, info: r.out.trim() };
    },
  },
  {
    name: 'node_modules/.bin exists',
    run: async () => {
      const dir = join(root, 'node_modules/.bin');
      return {
        ok: existsSync(dir),
        info: existsSync(dir) ? 'present' : 'MISSING',
        hint: 'Run `npm install` first',
      };
    },
  },
  {
    name: 'TypeScript (tsc)',
    run: async () => {
      const r = await run('tsc', ['--version']);
      return { ok: r.code === 0, info: r.out.trim() };
    },
  },
  {
    name: 'ESLint',
    run: async () => {
      const r = await run('eslint', ['--version']);
      return { ok: r.code === 0, info: r.out.trim() };
    },
  },
  {
    name: 'Prettier',
    run: async () => {
      const r = await run('prettier', ['--version']);
      return { ok: r.code === 0, info: r.out.trim() };
    },
  },
  {
    name: 'Vite',
    run: async () => {
      const r = await run('vite', ['--version']);
      return { ok: r.code === 0, info: r.out.trim() };
    },
  },
  {
    name: 'Vitest',
    run: async () => {
      const r = await run('vitest', ['--version']);
      return { ok: r.code === 0, info: r.out.trim() };
    },
  },
  {
    name: 'Playwright',
    run: async () => {
      const r = await run('playwright', ['--version']);
      return { ok: r.code === 0, info: r.out.trim() };
    },
  },
  {
    name: 'esbuild binary',
    run: async () => {
      const r = await run('node', ['-e', "require('esbuild'); console.log('ok')"]);
      return {
        ok: r.code === 0,
        info: r.code === 0 ? 'ok' : 'broken',
        hint: 'Run `node node_modules/esbuild/install.js`',
      };
    },
  },
  {
    name: 'PVAC WASM (public/wasm/pvac.wasm)',
    run: async () => {
      const wasmPath = join(root, 'public/wasm/pvac.wasm');
      const jsPath = join(root, 'public/wasm/pvac.js');
      const wasmExists = existsSync(wasmPath);
      const jsExists = existsSync(jsPath);
      return {
        ok: wasmExists && jsExists,
        info: wasmExists && jsExists ? 'present' : 'MISSING',
        hint:
          wasmExists && jsExists
            ? undefined
            : 'Run `bash scripts/build-wasm.sh` (requires Emscripten)',
      };
    },
  },
  {
    name: 'AML templates (public/templates/)',
    run: async () => {
      const tdir = join(root, 'public/templates');
      const expected = ['empty', 'token', 'vault', 'amm', 'escrow', 'multisig'];
      const missing = expected.filter((t) => !existsSync(join(tdir, t, 'main.aml')));
      return {
        ok: missing.length === 0,
        info: missing.length === 0 ? `${expected.length} templates` : `missing: ${missing.join(', ')}`,
      };
    },
  },
];

async function main() {
  console.log(`${COLORS.bold}═══ Orion Wallet — Health Check ═══${COLORS.reset}\n`);
  let allOk = true;
  for (const check of checks) {
    try {
      const result = await check.run();
      const status = result.ok ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
      const info = result.info ? ` ${COLORS.gray}(${result.info})${COLORS.reset}` : '';
      console.log(`  ${status} ${check.name}${info}`);
      if (!result.ok) {
        allOk = false;
        if (result.hint) {
          console.log(`    ${COLORS.yellow}→ ${result.hint}${COLORS.reset}`);
        }
      }
    } catch (e) {
      console.log(`  ${COLORS.red}✗${COLORS.reset} ${check.name} ${COLORS.gray}(error: ${e.message})${COLORS.reset}`);
      allOk = false;
    }
  }
  console.log('');
  if (allOk) {
    console.log(`${COLORS.green}${COLORS.bold}✓ All checks passed — toolchain ready${COLORS.reset}`);
    process.exit(0);
  } else {
    console.log(`${COLORS.yellow}${COLORS.bold}⚠ Some checks failed — see hints above${COLORES.reset}`.replace('COLORES', COLORS.reset));
    process.exit(1);
  }
}

main();
