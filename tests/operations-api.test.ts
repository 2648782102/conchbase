import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { createTaskService } from '../src/runtime/task-service.js';

function sse(): string {
  return 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
}

test('the data-location route reports path, size, and schema version', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-ops-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const service = createTaskService(databasePath, {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model',
    fetch: (async () => new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
  });
  const app = createApp({
    logger: false, taskService: service,
    config: {
      host: '127.0.0.1', port: 4318, databasePath, magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model', workspaceRoot: directory, executionMode: 'restricted',
      loopBudget: { maxIterations: 6, maxToolCallsPerTurn: 4, deadlineMs: 120_000 },
      workerSliceIterations: 0, projectIdleMs: 1_800_000, globalActiveWork: 8,
      perProjectActiveWork: 2, allowAuthenticatedRemoteBinding: false,
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/operations/data' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.databasePath, databasePath);
    assert.equal(body.schemaVersion, 9);
    assert.equal(typeof body.sizeBytes, 'number');
    assert.equal(JSON.stringify(body).includes('prompt'), false);
  } finally {
    service.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup writes a snapshot at a caller path and returns a verification summary', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-ops-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const target = path.join(directory, 'snapshot.sqlite');
  const service = createTaskService(databasePath, {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model',
    fetch: (async () => new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
  });
  const app = createApp({
    logger: false, taskService: service,
    config: {
      host: '127.0.0.1', port: 4318, databasePath, magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model', workspaceRoot: directory, executionMode: 'restricted',
      loopBudget: { maxIterations: 6, maxToolCallsPerTurn: 4, deadlineMs: 120_000 },
      workerSliceIterations: 0, projectIdleMs: 1_800_000, globalActiveWork: 8,
      perProjectActiveWork: 2, allowAuthenticatedRemoteBinding: false,
    },
  });
  try {
    const response = await app.inject({
      method: 'POST', url: '/v1/operations/backup',
      payload: { target },
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    assert.equal(existsSync(target), true);
    assert.equal(body.ok, true);
    assert.equal(typeof body.sizeBytes, 'number');
    assert.ok(Array.isArray(body.tables));
  } finally {
    service.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup refuses an existing target and an unsafe path', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-ops-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const service = createTaskService(databasePath, {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model',
    fetch: (async () => new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
  });
  const app = createApp({
    logger: false, taskService: service,
    config: {
      host: '127.0.0.1', port: 4318, databasePath, magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model', workspaceRoot: directory, executionMode: 'restricted',
      loopBudget: { maxIterations: 6, maxToolCallsPerTurn: 4, deadlineMs: 120_000 },
      workerSliceIterations: 0, projectIdleMs: 1_800_000, globalActiveWork: 8,
      perProjectActiveWork: 2, allowAuthenticatedRemoteBinding: false,
    },
  });
  try {
    for (const target of ['relative/path.sqlite', '/etc/passwd', path.join(directory, 'runtime.sqlite')]) {
      const response = await app.inject({ method: 'POST', url: '/v1/operations/backup', payload: { target } });
      assert.equal(response.statusCode, 400, `${target}: ${response.body}`);
    }
  } finally {
    service.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the diagnostics route returns check names and remedies, never prompts or secrets', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-ops-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const service = createTaskService(databasePath, {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model',
    fetch: (async () => new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
  });
  const app = createApp({
    logger: false, taskService: service,
    config: {
      host: '127.0.0.1', port: 4318, databasePath, magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model', workspaceRoot: directory, executionMode: 'restricted',
      loopBudget: { maxIterations: 6, maxToolCallsPerTurn: 4, deadlineMs: 120_000 },
      workerSliceIterations: 0, projectIdleMs: 1_800_000, globalActiveWork: 8,
      perProjectActiveWork: 2, allowAuthenticatedRemoteBinding: false,
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/operations/diagnostics' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(Array.isArray(body.checks));
    for (const check of body.checks) {
      assert.equal(typeof check.id, 'string');
      assert.ok(['ok', 'warn', 'fail'].includes(check.status));
      assert.equal(typeof check.detail, 'string');
    }
    assert.equal(JSON.stringify(body).includes('sk-'), false);
  } finally {
    service.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
