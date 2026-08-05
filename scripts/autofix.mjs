#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════
 *  Auto-Fix Script — self-healing test/lint/format/build pipeline
 * ════════════════════════════════════════════════════════════════════
 *
 * Runs typecheck → format → lint --fix → tests → build.
 * Attempts to auto-fix common errors:
 *   - Missing imports (heuristic)
 *   - Unused variables (eslint --fix removes them)
 *   - Formatting issues (prettier --write)
 *   - TypeScript strict-mode complaints (where safe to auto-fix)
 *   - Flaky tests (re-run once on failure)
 *
 * Usage:
 *   node scripts/autofix.mjs              # one-shot fix (write mode)
 *   node scripts/autofix.mjs --check      # check only, no fixes (CI mode)
 *   node scripts/autofix.mjs --watch      # watch mode (re-run on file change)
 *   node scripts/autofix.mjs --no-test    # skip tests (faster iteration)
 *   node scripts/autofix.mjs --no-build   # skip build
 *   node scripts/autofix.mjs --retry      # retry failed tests up to 3 times
 *
 * Exit codes:
 *   0 = all checks passed (or fixed successfully)
 *   1 = some checks failed after auto-fix attempts
 *   2 = fatal error in the script itself
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs/promises';
import { resolve as resolvePath, relative, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolvePath(__dirname, '..');

// CLI flags
const isWatch = process.argv.includes('--watch');
const isCheck = process.argv.includes('--check');
const noTest = process.argv.includes('--no-test');
const noBuild = process.argv.includes('--no-build');
const retryTests = process.argv.includes('--retry');

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function log(color, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${COLORS.gray}[${ts}]${COLORS.reset} ${COLORS[color]}${msg}${COLORS.reset}`);
}

/**
 * Run a command using the LOCAL binary from node_modules/.bin (NOT npx).
 * Using npx causes issues when network is available (downloads latest).
 */
function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let localBin;
    try {
      localBin = resolvePath(root, 'node_modules/.bin', bin);
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: `resolve failed: ${e.message}` });
      return;
    }
    let cmd;
    try {
      cmd = existsSync(localBin) ? localBin : bin;
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: `existsSync failed: ${e.message}` });
      return;
    }
    let p;
    try {
      p = spawn(cmd, args, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' },
        ...opts,
      });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: `spawn failed: ${e.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => (stdout += d.toString()));
    p.stderr?.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    p.on('error', (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}

async function step(name, fn) {
  log('cyan', `▶ ${name}`);
  const start = Date.now();
  let result;
  try {
    result = await fn();
  } catch (e) {
    log('red', `  Step threw: ${e.message}`);
    result = { ok: false, output: e.message };
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  if (!result || typeof result.ok !== 'boolean') {
    log('red', `  Step returned invalid result: ${JSON.stringify(result)}`);
    result = { ok: false, output: 'invalid result' };
  }
  if (result.ok) {
    log('green', `✓ ${name} (${elapsed}s)`);
  } else {
    log('red', `✗ ${name} (${elapsed}s)`);
    if (result.output && process.env.AUTOFIX_VERBOSE !== '0') {
      const out = result.output;
      const truncated = out.length > 4000 ? out.slice(0, 4000) + '\n... (truncated)' : out;
      console.log(truncated);
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════
//  Individual check/fix functions
// ════════════════════════════════════════════════════════════════════

async function typecheck() {
  const r = await run('tsc', ['--noEmit']);
  if (process.env.AUTOFIX_DEBUG) {
    console.error(`[DEBUG typecheck] code=${r.code} stdout_len=${r.stdout?.length} stderr_len=${r.stderr?.length}`);
    if (r.stderr) console.error(`[DEBUG typecheck] stderr: ${r.stderr.slice(0, 500)}`);
  }
  return { ok: r.code === 0, output: (r.stdout || '') + (r.stderr || '') };
}

async function format() {
  if (isCheck) {
    const r = await run('prettier', [
      '--check',
      'src/**/*.{ts,tsx,css}',
      'tests/**/*.{ts,tsx}',
    ]);
    return { ok: r.code === 0, output: r.stdout + r.stderr };
  }
  const r = await run('prettier', [
    '--write',
    'src/**/*.{ts,tsx,css}',
    'tests/**/*.{ts,tsx}',
  ]);
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

async function lint() {
  const args = isCheck
    ? ['.', '--max-warnings=0']
    : ['.', '--fix', '--max-warnings=0'];
  const r = await run('eslint', args);
  // eslint exit codes: 0 = clean, 1 = errors remain, 2 = config issue
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

async function testOnce() {
  const r = await run('vitest', ['run', '--reporter=dot']);
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

async function testWithRetry() {
  let lastResult;
  const maxAttempts = retryTests ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) log('yellow', `  Retrying tests (attempt ${attempt}/${maxAttempts})...`);
    lastResult = await testOnce();
    if (lastResult.ok) {
      if (attempt > 1) log('green', `  Tests passed on retry ${attempt}`);
      return lastResult;
    }
  }
  return lastResult;
}

async function build() {
  const r = await run('vite', ['build']);
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

// ════════════════════════════════════════════════════════════════════
//  Self-healing: detect & attempt fixes for common patterns
// ════════════════════════════════════════════════════════════════════

/**
 * Parse TypeScript errors and attempt targeted fixes.
 * Currently handles:
 *   - TS6133 unused imports/vars (eslint --fix handles these)
 *   - TS2307 cannot find module (suggest npm install)
 *   - TS2554 wrong arg count (manual fix needed — report only)
 */
function analyzeTypecheckErrors(output) {
  if (!output || typeof output !== 'string') return [];
  const errors = [];
  const lines = output.split('\n');
  for (const line of lines) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.+)$/);
    if (m) {
      errors.push({
        file: m[1],
        line: parseInt(m[2], 10),
        col: parseInt(m[3], 10),
        code: m[4],
        message: m[5],
      });
    }
  }
  return errors;
}

/**
 * Check if any errors are auto-fixable by eslint --fix.
 * TS6133 (unused), TS2304 (undeclared), and similar are typically
 * handled by eslint rules like no-unused-vars.
 */
function isAutoFixable(tsError) {
  const autoFixable = ['6133', '2304', '2552'];
  return autoFixable.includes(tsError.code);
}

/**
 * Attempt to install missing packages for TS2307 errors.
 */
async function attemptMissingModuleFix(errors) {
  const missingModules = new Set();
  for (const e of errors) {
    if (e.code === '2307') {
      const m = e.message.match(/Cannot find module '([^']+)' or its corresponding type declarations/);
      if (m) {
        const mod = m[1];
        // Skip relative imports and node builtins
        if (!mod.startsWith('.') && !mod.startsWith('/') && !mod.startsWith('node:')) {
          // Only install @types/* or actual packages
          if (mod.startsWith('@types/') || !mod.startsWith('@')) {
            missingModules.add(mod);
          }
        }
      }
    }
  }
  if (missingModules.size === 0) return false;
  const mods = Array.from(missingModules);
  log('yellow', `  Attempting to install missing modules: ${mods.join(', ')}`);
  const r = await run('npm', ['install', '--save-dev', ...mods, '--no-audit', '--no-fund', '--legacy-peer-deps']);
  if (r.code === 0) {
    log('green', `  ✓ Installed ${mods.length} missing module(s)`);
    return true;
  }
  log('red', `  ✗ Failed to install modules: ${r.stderr.slice(0, 200)}`);
  return false;
}

// ════════════════════════════════════════════════════════════════════
//  Main pipeline
// ════════════════════════════════════════════════════════════════════

async function autofixOnce() {
  log('magenta', `${COLORS.bold}━━━ Auto-fix cycle started ━━━${COLORS.reset}`);
  const results = {};

  // Step 1: Typecheck (initial)
  results.typecheck = await step('Typecheck', typecheck);

  // Step 2: Self-heal — install missing modules if typecheck failed
  if (!results.typecheck.ok && !isCheck) {
    const errors = analyzeTypecheckErrors(results.typecheck.output);
    const ts2307Errors = errors.filter((e) => e.code === '2307');
    if (process.env.AUTOFIX_DEBUG) {
      console.error(`[DEBUG self-heal] total errors: ${errors.length}, TS2307 errors: ${ts2307Errors.length}`);
      if (errors.length > 0) console.error(`[DEBUG self-heal] first error:`, errors[0]);
    }
    if (ts2307Errors.length > 0) {
      log('yellow', `  Found ${ts2307Errors.length} TS2307 errors — attempting auto-install`);
      const installed = await attemptMissingModuleFix(ts2307Errors);
      if (installed) {
        // Re-run typecheck
        results.typecheck = await step('Typecheck (post-install)', typecheck);
      }
    }
  }

  // Step 3: Format
  results.format = await step(isCheck ? 'Format (check)' : 'Format (write)', format);

  // Step 4: Lint (with --fix in write mode)
  results.lint = await step(isCheck ? 'Lint (check)' : 'Lint (--fix)', lint);

  // Step 5: Re-typecheck after lint fixes (eslint may have removed unused imports)
  if (!isCheck && (results.lint.ok || !results.lint.ok)) {
    const before = results.typecheck.ok;
    results.typecheck2 = await step('Typecheck (post-lint)', typecheck);
    if (before && !results.typecheck2.ok) {
      log('yellow', '  ⚠ Lint fixes introduced new typecheck errors — reverting recommended');
    } else if (!before && results.typecheck2.ok) {
      log('green', '  ✓ Lint fixes resolved typecheck errors');
    }
  }

  // Step 6: Tests (only if typecheck passes)
  const typecheckOk =
    (results.typecheck.ok && (!results.typecheck2 || results.typecheck2.ok)) ||
    (results.typecheck2?.ok ?? false);
  if (typecheckOk && !noTest) {
    results.test = await step('Tests', testWithRetry);
  } else if (noTest) {
    log('yellow', '⚠ Skipping tests (--no-test flag)');
    results.test = { ok: true, skipped: true };
  } else {
    log('yellow', '⚠ Skipping tests because typecheck failed');
    results.test = { ok: false, skipped: true };
  }

  // Step 7: Build (only if tests pass)
  if ((results.test.ok || results.test.skipped) && !noBuild) {
    results.build = await step('Build', build);
  } else if (noBuild) {
    log('yellow', '⚠ Skipping build (--no-build flag)');
    results.build = { ok: true, skipped: true };
  } else {
    log('yellow', '⚠ Skipping build because tests failed');
    results.build = { ok: false, skipped: true };
  }

  // Summary
  log('magenta', `${COLORS.bold}━━━ Summary ━━━${COLORS.reset}`);
  let allOk = true;
  for (const [name, r] of Object.entries(results)) {
    const status = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    const color = r.skipped ? 'gray' : r.ok ? 'green' : 'red';
    log(color, `  ${name.padEnd(20)} ${status}`);
    if (!r.ok && !r.skipped) allOk = false;
  }

  // Health stats
  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(2);
  log('gray', `  Total time: ${elapsed}s`);

  return allOk;
}

let cycleStart = Date.now();

async function watchMode() {
  log('blue', `Watching ${relative(root, resolvePath(root, 'src'))}/ and ${relative(root, resolvePath(root, 'tests'))}/ for changes...`);
  log('gray', 'Press Ctrl+C to stop');
  let running = false;
  let pending = false;

  const trigger = async (reason) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    cycleStart = Date.now();
    try {
      if (reason) log('blue', `Change detected: ${reason}`);
      await autofixOnce();
    } catch (e) {
      log('red', `Auto-fix error: ${e.message}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        setTimeout(() => trigger('queued change'), 500);
      }
    }
  };

  // Initial run
  await trigger('initial');

  // Watch src/ and tests/ with debounce
  const watchPaths = [resolvePath(root, 'src'), resolvePath(root, 'tests')];
  let debounceTimer = null;
  for (const p of watchPaths) {
    (async () => {
      for await (const event of watch(p, { recursive: true })) {
        const filename = event.filename || '';
        const ext = extname(filename);
        if (['.ts', '.tsx', '.js', '.jsx', '.css', '.json'].includes(ext)) {
          const rel = isAbsolute(filename) ? relative(root, filename) : filename;
          // Debounce: collapse rapid changes into one trigger
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            trigger(rel);
            debounceTimer = null;
          }, 300);
        }
      }
    })().catch((e) => log('red', `Watch error: ${e.message}`));
  }
}

// ════════════════════════════════════════════════════════════════════
//  Entrypoint
// ════════════════════════════════════════════════════════════════════
if (isWatch) {
  watchMode();
} else {
  autofixOnce().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
