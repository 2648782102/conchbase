import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelProviderError,
  OpenAiChatCompletionsProvider,
} from '../src/runtime/magpie-provider.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const config = {
  baseUrl: 'http://127.0.0.1:3425',
  model: 'fixture/model',
  appKey: 'magpie-conchbase',
};

test('the provider maps a chat completion to one final turn', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = new OpenAiChatCompletionsProvider({
    ...config,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'answer' } }],
      });
    },
  });

  const turn = await provider.nextTurn({
    taskId: 'task_fixture',
    prompt: 'hello',
    turnIndex: 0,
  });
  assert.deepEqual(turn, { kind: 'final', output: 'answer' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:3425/v1/chat/completions');
  const headers = requests[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer magpie-conchbase');
  const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'fixture/model');
  assert.equal(body.stream, false);
});

test('the provider rejects tool calls, empty content, and HTTP errors', async () => {
  const cases: Array<{ payload: unknown; status?: number; message: RegExp }> = [
    {
      payload: { choices: [{ message: { content: '', tool_calls: [] } }] },
      message: /tool calls are not supported/,
    },
    {
      payload: { choices: [{ message: { content: '' } }] },
      message: /empty completion/,
    },
    {
      payload: { error: 'unavailable' },
      status: 503,
      message: /HTTP 503/,
    },
  ];

  for (const item of cases) {
    const provider = new OpenAiChatCompletionsProvider({
      ...config,
      fetch: async () => jsonResponse(item.payload, item.status ?? 200),
    });
    await assert.rejects(
      provider.nextTurn({ taskId: 'task_fixture', prompt: 'hello', turnIndex: 0 }),
      (cause: unknown) => cause instanceof ModelProviderError
        && item.message.test(cause.message),
    );
  }
});

test('the provider rejects non-loopback URLs and later turns before fetching', () => {
  assert.throws(
    () => new OpenAiChatCompletionsProvider({
      ...config,
      baseUrl: 'https://example.com',
    }),
    ModelProviderError,
  );
  const provider = new OpenAiChatCompletionsProvider({
    ...config,
    fetch: async () => {
      throw new Error('fetch must not be called');
    },
  });
  assert.rejects(
    provider.nextTurn({ taskId: 'task_fixture', prompt: 'hello', turnIndex: 1 }),
    ModelProviderError,
  );
});
