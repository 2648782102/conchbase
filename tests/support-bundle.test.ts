import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSupportBundle, formatSupportBundle } from '../src/runtime/support-bundle.js';
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/runtime/task-store-migrations.js';

test('a bundle summarizes version, data, and checks without sensitive fields', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-bundle-'));
  try {
    const bundle = await buildSupportBundle({
      version: '1.0.0',
      databasePath: path.join(directory, 'runtime.sqlite'),
      workspaceRoot: directory,
      port: 4318,
      host: '127.0.0.1',
      magpieBaseUrl: 'http://127.0.0.1:3425',
      checks: [
        { id: 'node', status: 'ok', detail: 'Node.js 24.22.2 is supported.' },
        { id: 'gateway', status: 'warn', detail: 'unreachable' },
      ],
      generatedAt: '2026-11-20T00:00:00.000Z',
    });
    assert.equal(bundle.version, '1.0.0');
    assert.equal(bundle.data.databasePath, path.join(directory, 'runtime.sqlite'));
    assert.equal(bundle.data.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    assert.equal(bundle.checks.length, 2);
    const json = JSON.stringify(bundle);
    for (const forbidden of ['prompt', 'messages', 'transcript', 'secret', 'sk-']) {
      assert.equal(json.includes(forbidden), false, `bundle must not mention ${forbidden}`);
    }
    // A failing/warning check is summarized so support can act on it.
    assert.equal(bundle.summary.status, 'warn');
    assert.match(bundle.summary.nextStep ?? '', /gateway/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an all-ok bundle reports ok and needs no next step', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-bundle-'));
  try {
    const bundle = await buildSupportBundle({
      version: '1.0.0', databasePath: path.join(directory, 'r.sqlite'), workspaceRoot: directory,
      port: 4318, host: '127.0.0.1', magpieBaseUrl: 'http://127.0.0.1:3425',
      checks: [{ id: 'node', status: 'ok', detail: 'fine' }],
      generatedAt: '2026-11-20T00:00:00.000Z',
    });
    assert.equal(bundle.summary.status, 'ok');
    assert.equal(bundle.summary.nextStep, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the text form is copy-pasteable and bounded', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-bundle-'));
  try {
    const bundle = await buildSupportBundle({
      version: '1.0.0', databasePath: path.join(directory, 'r.sqlite'), workspaceRoot: directory,
      port: 4318, host: '127.0.0.1', magpieBaseUrl: 'http://127.0.0.1:3425',
      checks: [{ id: 'node', status: 'fail', detail: 'Node.js 22 is too old.' }],
      generatedAt: '2026-11-20T00:00:00.000Z',
    });
    const text = formatSupportBundle(bundle);
    assert.match(text, /Conchbase support bundle/);
    assert.match(text, /node/);
    assert.ok(text.length < 4000, 'text form stays small enough to paste');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
