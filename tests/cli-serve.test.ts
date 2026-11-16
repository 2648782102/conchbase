import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * `conchbase serve` end to end.
 *
 * This is the only path that binds a real listener, and it was the largest
 * uncovered branch in `cli.ts`. Everything else routes through `createApp`,
 * which other suites exercise directly; a regression here would mean the
 * operator-facing entry point is broken while every unit test still passes.
 *
 * The port is allocated by asking the OS for a free one and releasing it, so
 * parallel runs cannot collide. The database lives in a temp directory.
 */
const root = path.join(import.meta.dirname, '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

async function waitForHealth(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/v1/health`);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('serve binds a real listener and answers the runtime contract', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-serve-'));
  const workspace = path.join(directory, 'workspace');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'serve'],
    {
      cwd: root,
      env: {
        ...process.env,
        CONCHBASE_PORT: String(port),
        CONCHBASE_DB: path.join(directory, 'runtime.sqlite'),
        CONCHBASE_WORKSPACE_ROOT: workspace,
        CONCHBASE_MAGPIE_URL: 'http://127.0.0.1:3425',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs: string[] = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  try {
    assert.equal(await waitForHealth(base, 30_000), true, logs.join('').slice(-1500));

    const health = await (await fetch(`${base}/v1/health`)).json() as { status: string; service: string };
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'conchbase');

    const runtime = await (await fetch(`${base}/v1/runtime`)).json() as {
      state: string;
      capabilities: readonly string[];
      projectConvergence?: { idleAfterMs: number };
    };
    assert.equal(runtime.state, 'ready');
    // Tasks are enabled in `serve`, so the full capability set must be present.
    assert.ok(runtime.capabilities.includes('tasks'));
    assert.ok(runtime.capabilities.includes('agents'));
    assert.ok(runtime.projectConvergence, 'the convergence policy is published');

    // The workspace root is created at startup; a worker could not read it
    // otherwise. This also proves the pre-listen wiring ran.
    assert.equal(existsSync(workspace), true, 'workspace root must exist before tools are used');

    // An unconfigured store should still answer 200 with an empty list rather
    // than 503: `serve` always constructs the task service.
    const agents = await fetch(`${base}/v1/agents`);
    assert.equal(agents.status, 200);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(null); });
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('serve releases the port when it is stopped', async () => {
  // A leaked listener makes the next start fail with EADDRINUSE, which is the
  // first symptom an operator would hit.
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-serve-stop-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'serve'],
    {
      cwd: root,
      env: {
        ...process.env,
        CONCHBASE_PORT: String(port),
        CONCHBASE_DB: path.join(directory, 'runtime.sqlite'),
        CONCHBASE_WORKSPACE_ROOT: path.join(directory, 'workspace'),
        CONCHBASE_MAGPIE_URL: 'http://127.0.0.1:3425',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    assert.equal(await waitForHealth(base, 30_000), true);
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(null); });
    });
    // The port must be bindable again immediately.
    const rebound = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    assert.equal(rebound, true, 'port must be released on shutdown');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});
