#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════
 *  Dev Watcher — parallel dev server + tests + autofix
 * ════════════════════════════════════════════════════════════════════
 *
 * Runs in parallel:
 *   1. Vite dev server (http://localhost:5173) — instant HMR
 *   2. Vitest watch mode — re-runs affected tests on file change
 *   3. Auto-fix watcher — typecheck + lint + format on save
 *
 * All output is color-prefixed by source for easy identification.
 * Ctrl+C kills all child processes cleanly.
 *
 * Usage: node scripts/watch-dev.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(__dirname, '..');

const COLORS = [
  { prefix: '\x1b[36m', name: 'vite' }, // cyan
  { prefix: '\x1b[35m', name: 'vitest' }, // magenta
  { prefix: '\x1b[33m', name: 'autofix' }, // yellow
  { prefix: '\x1b[32m', name: 'tsc' }, // green
];
const RESET = '\x1b[0m';
const GRAY = '\x1b[90m';

const procs = [];

function start(name, cmd, args, color) {
  const p = spawn(cmd, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const prefix = `${color}[${name.padEnd(8)}]${RESET} `;
  const errPrefix = `${color}[${name.padEnd(8)}]${RESET} `;

  p.stdout?.on('data', (d) => {
    d.toString()
      .split('\n')
      .forEach((line) => {
        if (line.length > 0) process.stdout.write(prefix + line + '\n');
      });
  });
  p.stderr?.on('data', (d) => {
    d.toString()
      .split('\n')
      .forEach((line) => {
        if (line.length > 0) process.stderr.write(errPrefix + line + '\n');
      });
  });
  p.on('exit', (code) => {
    process.stderr.write(
      `${GRAY}[${name}] exited with code ${code}${RESET}\n`,
    );
  });
  p.on('error', (err) => {
    process.stderr.write(
      `${GRAY}[${name}] failed to start: ${err.message}${RESET}\n`,
    );
  });
  procs.push(p);
  return p;
}

function killAll() {
  console.log('\nShutting down all processes...');
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
      // Force kill after 2s if still alive
      setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 2000);
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', killAll);
process.on('SIGTERM', killAll);

console.log('Starting parallel dev processes...\n');

// 1. Vite dev server (frontend with HMR)
start('vite', 'node_modules/.bin/vite', ['--port', '5173', '--clearScreen', 'false'], COLORS[0].prefix);

// 2. Vitest watch mode (re-runs affected tests)
// Wait 2s for Vite to start before starting vitest
setTimeout(() => {
  start(
    'vitest',
    'node_modules/.bin/vitest',
    ['--watch', '--reporter=dot', '--no-coverage'],
    COLORS[1].prefix,
  );
}, 2000);

// 3. Auto-fix watcher (typecheck + lint + format on save)
// Wait 4s so vitest can start first
setTimeout(() => {
  start(
    'autofix',
    'node',
    ['scripts/autofix.mjs', '--watch', '--no-test', '--no-build'],
    COLORS[2].prefix,
  );
}, 4000);

console.log('\nAll processes starting. Press Ctrl+C to stop.');
console.log('  Vite:     http://localhost:5173');
console.log('  Vitest:   watch mode (affected tests only)');
console.log('  Autofix:  typecheck + lint + format on save\n');
