#!/usr/bin/env node
/**
 * Launches the local Runtime and Pagurus together for a first-time user.
 *
 * Both processes are children of this command: one Ctrl-C stops both, and the
 * chosen ports are printed once so the user knows exactly what to open.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveWorktreeEnv } from './worktree-env.mjs';

const root = path.join(import.meta.dirname, '..');
const session = resolveWorktreeEnv(process.cwd(), process.env);
const runtimePort = Number(session.port);
const consolePort = 5173 + (runtimePort - 4318);
const children = [];
let stopping = false;

function start(label, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  children.push(child);
  child.once('exit', (code, signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\n${label} stopped (${signal ?? `exit ${code}`}); stopping the other process.\n`);
    for (const other of children) {
      if (other !== child && other.exitCode === null) other.kill('SIGTERM');
    }
    process.exit(code ?? 0);
  });
  return child;
}

process.stdout.write([
  '',
  '  Conchbase + Pagurus',
  `  Runtime API    http://127.0.0.1:${runtimePort}/v1/health`,
  `  Agent console  http://127.0.0.1:${consolePort}/   (the console prints its own token URL)`,
  '  Ctrl-C stops both processes.',
  '',
].join('\n'));

/** The console's deployment layer: points it at the Runtime and drops the
 * account, scheduler, and marketplace surfaces this product does not have. */
const overlay = path.join(root, 'deploy', 'pagurus-overlay.yml');

start('Runtime', process.execPath, ['scripts/dev.mjs'], root, { ...process.env });
/*
 * The console is the Pagurus tree, which is a profile of `dsh web` — not a Vite
 * dev server. It prints its own token-bearing URL, so the banner above names the
 * port the profile binds rather than one the probe invented.
 */
start('Pagurus', 'npm', ['run', 'start:web', '--', '--patch', overlay, '--port', String(consolePort), '--host', '127.0.0.1'], path.join(root, 'pagurus'), {
  ...process.env,
  CONCHBASE_PORT: String(runtimePort),
  CONCHBASE_HOME: root,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      process.exit(0);
    }, 5_000).unref();
  });
}
