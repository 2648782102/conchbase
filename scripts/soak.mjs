#!/usr/bin/env node
/**
 * Long-running soak check (not part of `npm test`).
 *
 * Drives many tasks through the real Runtime against the deterministic fixture
 * provider and watches for the failures that only show up over time: event
 * growth without bound, task records that never reach a terminal state, and
 * database size that does not stabilize.
 *
 *   node scripts/soak.mjs --iterations 200 --model fixture/model
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const iterations = Number(arg('iterations', '100'));
const model = arg('model', process.env.CONCHBASE_SOAK_MODEL ?? 'workbuddy/blind-model-h');
// A slow model is not a Runtime bug: give a task a generous ceiling and report
// a timeout distinctly from a wrong terminal state.
const taskTimeoutMs = Number(arg('task-timeout-ms', '300000'));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-soak-'));
const database = path.join(directory, 'runtime.sqlite');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], {
  cwd: root,
  env: { ...process.env, CONCHBASE_PORT: String(port), CONCHBASE_DB: database, CONCHBASE_WORKSPACE_ROOT: path.join(directory, 'ws'), CONCHBASE_MODEL: model },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const waitForHealth = async () => {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/v1/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

let failed = false;
try {
  if (!await waitForHealth()) throw new Error('runtime did not start');
  const sizes = [];
  for (let i = 0; i < iterations; i += 1) {
    const created = await fetch(`${base}/v1/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: `soak ${i}` }),
    });
    const task = (await created.json()).task;
    let state = task.state;
    const deadline = Date.now() + taskTimeoutMs;
    while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      state = (await (await fetch(`${base}/v1/tasks/${task.id}`)).json()).task?.state ?? state;
    }
    if (state === 'running' || state === 'queued' || state === 'waiting_approval') {
      failed = true;
      process.stderr.write(`iteration ${i}: task ${task.id} still ${state} after ${taskTimeoutMs}ms (model too slow or a real hang)\n`);
      break;
    }
    if (state !== 'succeeded') {
      failed = true;
      process.stderr.write(`iteration ${i}: task ${task.id} ended ${state}\n`);
      break;
    }
    if (i % 20 === 0) sizes.push(statSync(database).size);
    if (i % 10 === 0) process.stdout.write(`${i}/${iterations} ok  db=${Math.round(statSync(database).size / 1024)}KB\n`);
  }
  const finalSize = statSync(database).size;
  process.stdout.write(`\nsoak complete: ${iterations} tasks, final db ${Math.round(finalSize / 1024)}KB\n`);
} catch (cause) {
  failed = true;
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  child.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
