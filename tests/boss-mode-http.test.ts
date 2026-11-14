import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';

async function withApp(action: (app: ReturnType<typeof createApp>, service: BossModeService) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-http-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fixture-model', display_name: 'Fixture' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input).endsWith('/v1/chat/completions')) {
        return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected model call: ${String(input)}`);
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  const service = new BossModeService(store, taskService);
  const app = createApp({
    logger: false,
    taskService,
    bossModeService: service,
  });
  try {
    await action(app, service);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('primary intent HTTP entry creates published project and dynamic worker state', async () => {
  await withApp(async (app, service) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/organization/session/intents',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        intent: {
          text: 'Start project alpha and hire worker beta.',
          idempotencyKey: 'http-boss-fixture',
          expectedSequence: 0,
        },
      }),
    });
    assert.equal(response.statusCode, 202);
    assert.match(response.json().intentId, /^int_[0-9a-f]{24}$/);

    const snapshot = await app.inject({ method: 'GET', url: '/v1/organization/session' });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().projects.length, 1);
    assert.equal(snapshot.json().workers.length, 1);
    assert.equal(service.snapshot().workers[0]?.state, 'reporting');

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/organization/session/intents',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        intent: {
          text: 'Start project alpha and hire worker beta.',
          idempotencyKey: 'http-boss-fixture',
          expectedSequence: 0,
        },
      }),
    });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().intentId, response.json().intentId);
    assert.equal(replay.json().state, 'accepted');
  });
});
