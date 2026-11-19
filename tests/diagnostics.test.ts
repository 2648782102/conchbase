import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDiagnosticChecks, formatDiagnostics, type DiagnosticContext } from '../src/runtime/diagnostics.js';

function baseContext(directory: string): DiagnosticContext {
  return {
    nodeVersion: '24.22.2',
    databasePath: path.join(directory, 'runtime.sqlite'),
    workspaceRoot: directory,
    port: 4318,
    host: '127.0.0.1',
    magpieBaseUrl: 'http://127.0.0.1:3425',
    consolePort: 5173,
    checkPort: async () => 'free',
    checkHttp: async () => 'reachable',
    modelCount: async () => 3,
  };
}

test('a healthy environment reports every check as ok', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-diag-'));
  try {
    const checks = await buildDiagnosticChecks(baseContext(directory));
    const ids = checks.map((check) => check.id);
    for (const id of ['node', 'database', 'workspace', 'runtime-port', 'gateway', 'console']) {
      assert.ok(ids.includes(id), `missing check ${id}`);
    }
    assert.equal(checks.every((check) => check.status === 'ok'), true, JSON.stringify(checks, null, 2));
    assert.equal(formatDiagnostics(checks).includes('ok'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an old Node version is a failure, not a warning', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-diag-'));
  try {
    const checks = await buildDiagnosticChecks({ ...baseContext(directory), nodeVersion: '22.11.0' });
    const node = checks.find((check) => check.id === 'node');
    assert.equal(node?.status, 'fail');
    assert.match(node?.detail ?? '', /Node\.js 24/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing workspace and unreachable gateway are reported separately', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-diag-'));
  try {
    const checks = await buildDiagnosticChecks({
      ...baseContext(directory),
      workspaceRoot: path.join(directory, 'does-not-exist'),
      checkHttp: async (url) => (url.includes('3425') ? 'unreachable' : 'reachable'),
    });
    assert.equal(checks.find((check) => check.id === 'workspace')?.status, 'fail');
    assert.equal(checks.find((check) => check.id === 'gateway')?.status, 'warn');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an occupied runtime port is a warning with the reason', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-diag-'));
  try {
    const checks = await buildDiagnosticChecks({ ...baseContext(directory), checkPort: async () => 'busy' });
    const port = checks.find((check) => check.id === 'runtime-port');
    assert.equal(port?.status, 'warn');
    assert.match(port?.detail ?? '', /in use|already/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
