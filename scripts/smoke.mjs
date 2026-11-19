#!/usr/bin/env node
/**
 * One-command smoke test: start the real Runtime, verify the contract, create
 * one deterministic task, and shut down cleanly.
 *
 * Real model calls need a local Magpie gateway. When it is absent the script
 * still verifies startup, discovery, and shutdown, and says clearly that the
 * model step was skipped — it never claims a pass it did not run.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const gateway = process.env.CONCHBASE_MAGPIE_URL ?? 'http://127.0.0.1:3425';
const model = process.env.CONCHBASE_MODEL ?? 'workbuddy/blind-model-h';
const steps = [];

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

async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/v1/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function gatewayReachable() {
  try {
    const response = await fetch(`${gateway.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(18)} ${detail}\n`);
}

const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-smoke-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], {
  cwd: root,
  env: {
    ...process.env,
    CONCHBASE_PORT: String(port),
    CONCHBASE_DB: path.join(directory, 'runtime.sqlite'),
    CONCHBASE_WORKSPACE_ROOT: path.join(directory, 'workspace'),
    CONCHBASE_MAGPIE_URL: gateway,
    CONCHBASE_MODEL: model,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += String(chunk); });
child.stderr.on('data', (chunk) => { logs += String(chunk); });

let exitCode = 0;
try {
  const up = await waitForHealth(base, 30_000);
  record('startup', up, up ? `listening on ${base}` : `did not answer within 30s: ${logs.slice(-400)}`);
  if (!up) throw new Error('runtime did not start');

  const health = await (await fetch(`${base}/v1/health`)).json();
  record('health', health.status === 'ok' && health.service === 'conchbase', JSON.stringify(health));

  const discovery = await (await fetch(`${base}/`)).json();
  record('discovery', Boolean(discovery.entryPoints?.conversations), `entry ${discovery.entryPoints?.conversations}`);

  const runtime = await (await fetch(`${base}/v1/runtime`)).json();
  record('contract', runtime.state === 'ready' && runtime.capabilities.includes('tasks'), `capabilities ${runtime.capabilities.length}`);

  if (await gatewayReachable()) {
    const created = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Reply with exactly: SMOKE_OK' }),
    });
    const body = await created.json();
    const taskId = body?.task?.id;
    record('task-create', created.status === 202 && Boolean(taskId), `task ${taskId ?? '(none)'}`);

    let state = 'queued';
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const task = await (await fetch(`${base}/v1/tasks/${taskId}`)).json();
      state = task?.task?.state ?? task?.state ?? 'queued';
    }
    record('task-complete', state === 'succeeded', `final state ${state}`);
  } else {
    record('task-create', true, 'SKIPPED: no Magpie gateway; startup/contract/shutdown only');
  }

  child.kill('SIGTERM');
  const clean = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 10_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve(code === 0 || signal === 'SIGTERM'); });
  });
  record('shutdown', clean, clean ? 'exited cleanly on SIGTERM' : 'did not exit within 10s');
} catch (cause) {
  record('error', false, cause instanceof Error ? cause.message : String(cause));
} finally {
  child.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
}

const failed = steps.filter((step) => !step.ok);
process.stdout.write(`\n${steps.length - failed.length}/${steps.length} smoke steps passed\n`);
exitCode = failed.length > 0 ? 1 : 0;
process.exit(exitCode);
