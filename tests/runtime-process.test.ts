import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isProcessAlive,
  readPid,
  runtimeProcessPaths,
  startBackground,
  stopBackground,
  tailLog,
} from '../src/runtime/runtime-process.js';

test('pid and log files sit beside the database', () => {
  const paths = runtimeProcessPaths('/tmp/x/runtime.sqlite');
  assert.equal(paths.pidFile, '/tmp/x/runtime.pid');
  assert.equal(paths.logFile, '/tmp/x/runtime.log');
});

test('a missing pid file reads as null and an unreadable value is ignored', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-proc-'));
  try {
    const paths = runtimeProcessPaths(path.join(directory, 'runtime.sqlite'));
    assert.equal(readPid(paths.pidFile), null);
    writeFileSync(paths.pidFile, 'not-a-pid');
    assert.equal(readPid(paths.pidFile), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('start spawns a detached child, records its pid, and stop reaps it', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-proc-'));
  const paths = runtimeProcessPaths(path.join(directory, 'runtime.sqlite'));
  try {
    // A tiny sleeper stands in for the Runtime: the lifecycle is what matters.
    const started = startBackground({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: directory,
      env: process.env,
      paths,
    });
    assert.ok(started.pid > 0);
    assert.equal(readPid(paths.pidFile), started.pid);
    assert.equal(isProcessAlive(started.pid), true);

    const stop = await stopBackground({ paths, timeoutMs: 5_000, pollMs: 25 });
    assert.equal(stop.stopped, true);
    assert.equal(isProcessAlive(started.pid), false);
    assert.equal(existsSync(paths.pidFile), false, 'pid file is cleared');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('starting refuses when a live pid file already exists', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-proc-'));
  const paths = runtimeProcessPaths(path.join(directory, 'runtime.sqlite'));
  try {
    const first = startBackground({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: directory, env: process.env, paths,
    });
    assert.throws(() => startBackground({
      executable: process.execPath,
      args: ['-e', '0'],
      cwd: directory, env: process.env, paths,
    }), /already running/);
    await stopBackground({ paths, timeoutMs: 5_000, pollMs: 25 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stopping with no pid file reports nothing to stop', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-proc-'));
  try {
    const result = await stopBackground({ paths: runtimeProcessPaths(path.join(directory, 'runtime.sqlite')) });
    assert.equal(result.stopped, false);
    assert.equal(result.pid, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tailLog returns the last lines and tolerates a missing file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-proc-'));
  try {
    const logFile = path.join(directory, 'runtime.log');
    assert.equal(tailLog(logFile), '');
    writeFileSync(logFile, 'a\nb\nc\n');
    assert.equal(tailLog(logFile, 2), 'b\nc');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a source entry needs the tsx loader, a built entry does not', async () => {
  const { buildServeArgs } = await import('../src/runtime/runtime-process.js');
  assert.deepEqual(buildServeArgs('/repo/src/cli.ts'), ['--import', 'tsx', '/repo/src/cli.ts', 'serve']);
  assert.deepEqual(buildServeArgs('/repo/dist/cli.js'), ['/repo/dist/cli.js', 'serve']);
});
