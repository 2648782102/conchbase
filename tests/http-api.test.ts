import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';

test('read-only status routes return the documented API shapes', async () => {
  const app = createApp({ logger: false });

  try {
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      status: 'ok',
      service: 'conchbase',
      apiVersion: 1,
    });

    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });
    assert.equal(runtime.statusCode, 200);
    assert.deepEqual(runtime.json(), {
      name: 'Conchbase',
      version: '1.0.0',
      state: 'ready',
      executionMode: 'restricted',
      capabilities: [],
    });

    const tasks = await app.inject({ method: 'GET', url: '/v1/tasks' });
    assert.equal(tasks.statusCode, 503);
  } finally {
    await app.close();
  }

  const configured = createApp({ logger: false, taskService: {} as never });
  try {
    const runtime = await configured.inject({ method: 'GET', url: '/v1/runtime' });
    assert.deepEqual(runtime.json<{ capabilities: string[] }>().capabilities, [
      'tasks',
      'events',
      'models',
      'streaming-output',
      'configuration-revisions',
      'composition-execution',
      'tool-approval-ledger',
      'provider-tool-call-observation',
      'agents',
      'provider-neutral-model-catalog',
      'durable-work-contract',
      'authenticated-pairing',
      'asynchronous-work-control',
      'local-source-policy',
      'capability-directory',
      'write-only-secret-handles',
      'execution-modes',
    ]);
  } finally {
    await configured.close();
  }
});

test('a loopback binding rejects a rebinding Host header before any route runs', async () => {
  // Loopback binding carries no token, so the Host name is the only proof that
  // the caller actually addressed 127.0.0.1. A rebinding page keeps its own
  // domain in Host while the socket stays local; without this check it reads
  // task output and tool results as if it were same-origin.
  const app = createApp({ logger: false });
  try {
    const rebinding = await app.inject({
      method: 'GET', url: '/v1/health', headers: { host: 'evil.example' },
    });
    assert.equal(rebinding.statusCode, 421);

    const crossSiteWrite = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { host: '127.0.0.1:4318', 'sec-fetch-site': 'cross-site' },
      payload: { prompt: 'x' },
    });
    assert.equal(crossSiteWrite.statusCode, 403);

    for (const host of ['127.0.0.1:4318', 'localhost:4318', '[::1]:4318']) {
      const allowed = await app.inject({ method: 'GET', url: '/v1/health', headers: { host } });
      assert.equal(allowed.statusCode, 200, host);
    }
  } finally {
    await app.close();
  }
});
