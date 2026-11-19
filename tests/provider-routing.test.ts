import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';

/**
 * A registered provider that is never reached is a false positive.
 *
 * `provider-registry.ts` lists `openai-compatible`, so an Agent may name it and
 * the API accepts it. Every request must then go to that provider's own base
 * URL. Today every call still uses the Magpie URL and stamps `magpie` on the
 * catalog, which silently routes a second provider to the first gateway.
 */

interface Recorded {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function gatewayRecorder(): { readonly calls: Recorded[]; readonly fetch: typeof globalThis.fetch } {
  const calls: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
    });
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'shared-model', display_name: 'Shared' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test('an Agent naming openai-compatible reaches that base URL and credential', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-provider-routing-'));
  const recorder = gatewayRecorder();
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    magpieAppKey: 'magpie-key',
    defaultModel: 'shared-model',
    providers: {
      'openai-compatible': { baseUrl: 'http://127.0.0.1:8123', appKey: 'compatible-key' },
    },
    fetch: recorder.fetch,
  });
  try {
    const agent = await service.createAgent({
      name: '兼容端点', instructions: 'x',
      providerId: 'openai-compatible', modelId: 'shared-model',
    });
    const task = await service.createAgentTask({ prompt: 'hello', agentId: agent.id });
    service.startTask(task.id);
    const finished = await service.waitForTask(task.id);
    assert.equal(finished.state, 'succeeded', `task failed: ${finished.error ?? 'unknown'}`);

    const completion = recorder.calls.find((call) => call.url.endsWith('/chat/completions'));
    assert.ok(completion, 'the task made a chat completion call');
    assert.equal(completion.url, 'http://127.0.0.1:8123/v1/chat/completions');
    assert.equal(completion.authorization, 'Bearer compatible-key');
    const modelRequest = recorder.calls.find((call) => call.url.endsWith('/v1/models'));
    assert.equal(modelRequest?.url, 'http://127.0.0.1:8123/v1/models');
    assert.equal(
      recorder.calls.some((call) => call.url.startsWith('http://127.0.0.1:3425')),
      false,
      'no request may fall back to the Magpie gateway',
    );
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a registered provider with no endpoint fails instead of borrowing Magpie', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-provider-unset-'));
  const recorder = gatewayRecorder();
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'shared-model',
    fetch: recorder.fetch,
  });
  try {
    await assert.rejects(
      () => service.createAgent({
        name: '未配置端点', instructions: 'x',
        providerId: 'openai-compatible', modelId: 'shared-model',
      }),
      /has no endpoint configured/,
    );
    assert.deepEqual(recorder.calls, [], 'an unconfigured provider must make no request at all');
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each provider publishes its own models instead of one Magpie catalog', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-provider-catalog-'));
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const id = url.startsWith('http://127.0.0.1:8123') ? 'compatible-only' : 'magpie-only';
    return new Response(JSON.stringify({ data: [{ id }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'magpie-only',
    providers: {
      'openai-compatible': { baseUrl: 'http://127.0.0.1:8123' },
    },
    fetch,
  });
  try {
    const models = await service.listProviderModels();
    const references = models.map((model) => model.reference).sort();
    assert.deepEqual(references, ['magpie:magpie-only', 'openai-compatible:compatible-only']);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
