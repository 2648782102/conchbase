import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { toolArgumentsDigest } from '../src/runtime/tool-request.js';

function toolCallPayload(): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'fixture_read',
            arguments: JSON.stringify({ value: 'bounded' }),
          },
        }],
      },
    }],
  };
}

test('the observation route returns one transient normalized tool call without persisting it', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-observation-api-'));
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  const app = createApp({ logger: false });

  try {
    const before = store.listEvents(null);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-observations/tool-calls',
      payload: { version: 1, provider: 'openai-chat-completions', payload: toolCallPayload() },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      observation: {
        version: 1,
        kind: 'tool_call',
        provider: 'openai-chat-completions',
        providerToolCallId: 'call_1',
        toolCall: { toolName: 'fixture_read', arguments: { value: 'bounded' } },
        argumentsDigest: toolArgumentsDigest({ value: 'bounded' }),
      },
    });
    assert.deepEqual(store.listEvents(null), before);
    assert.deepEqual(store.listTasks(), []);
    assert.equal(store.getToolRequest('tqr_000000000000000000000000'), null);
    assert.doesNotMatch(response.body, /taskId|compositionNodeId|tool\.executed|executor/);
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the observation route distinguishes no observation from bounded validation errors', async () => {
  const app = createApp({ logger: false });
  try {
    const noObservation = await app.inject({
      method: 'POST',
      url: '/v1/provider-observations/tool-calls',
      payload: {
        version: 1,
        provider: 'openai-chat-completions',
        payload: { choices: [{ message: { content: 'answer' } }] },
      },
    });
    assert.equal(noObservation.statusCode, 200);
    assert.deepEqual(noObservation.json(), { observation: null });

    const cases: Record<string, unknown>[] = [
      { version: 2, provider: 'openai-chat-completions', payload: toolCallPayload() },
      { version: 1, provider: 'other', payload: toolCallPayload() },
      { version: 1, provider: 'openai-chat-completions', payload: {} },
      { version: 1, provider: 'openai-chat-completions', payload: { usage: 1 } },
      {
        version: 1,
        provider: 'openai-chat-completions',
        payload: { choices: [{ message: { role: 'assistant', content: 'answer' } }] },
      },
      {
        version: 1,
        provider: 'openai-chat-completions',
        payload: { choices: [{ delta: { tool_calls: [] } }] },
      },
      {
        version: 1,
        provider: 'openai-chat-completions',
        payload: { choices: [{ message: { content: null, tool_calls: [] } }] },
      },
    ];
    for (const payload of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/provider-observations/tool-calls',
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.ok(Array.isArray(response.json<{ details: unknown[] }>().details));
    }
  } finally {
    await app.close();
  }
});
