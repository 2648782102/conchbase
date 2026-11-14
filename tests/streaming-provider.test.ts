import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelProviderError,
  OpenAiChatCompletionsProvider,
  STREAMING_OUTPUT_LIMITS,
} from '../src/runtime/magpie-provider.js';
import { toolArgumentsDigest } from '../src/runtime/tool-request.js';

const config = {
  baseUrl: 'http://127.0.0.1:3425',
  model: 'fixture/model',
  appKey: 'magpie-conchbase',
};

function sseResponse(frames: readonly string[], status = 200): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function chunk(content: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    choices: [{ delta: { content, ...extra }, finish_reason: null }],
  });
}

test('the streaming provider emits answer text and ignores reasoning text', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = new OpenAiChatCompletionsProvider({
    ...config,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return sseResponse([
        chunk(null, { reasoning_content: 'hidden' }),
        chunk('hello'),
        chunk(' world'),
      ]);
    },
  });
  const deltas: string[] = [];

  const turn = await provider.streamTurn({
    taskId: 'task_fixture',
    prompt: 'hello',
    turnIndex: 0,
    onOutputDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(turn, { kind: 'final', output: 'hello world' });
  assert.deepEqual(deltas, ['hello', ' world']);
  assert.equal(requests.length, 1);
  const headers = requests[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Accept, 'text/event-stream');
  const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body.stream, true);
});

test('the streaming provider accepts one whole message-shaped tool call without emitting text', async () => {
  const provider = new OpenAiChatCompletionsProvider({
    ...config,
    fetch: async () => sseResponse([JSON.stringify({
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
    })]),
  });
  const deltas: string[] = [];

  const turn = await provider.streamTurn({
    taskId: 'task_fixture',
    prompt: 'hello',
    turnIndex: 0,
    onOutputDelta: (delta) => deltas.push(delta),
  });

  assert.equal(turn.kind, 'tool_call_observation');
  assert.ok(turn.kind === 'tool_call_observation');
  assert.deepEqual(turn.observation.toolCall, {
    toolName: 'fixture_read',
    arguments: { value: 'bounded' },
  });
  assert.equal(turn.observation.argumentsDigest, toolArgumentsDigest({ value: 'bounded' }));
  assert.deepEqual(deltas, []);
});

test('the streaming provider rejects malformed tool calls, frames, and empty output', async () => {
  const cases: Array<{ response: () => Response; message: RegExp }> = [
    {
      response: () => sseResponse([JSON.stringify({
        choices: [{ delta: { content: null, tool_calls: [] } }],
      })]),
      message: /unsupported tool call/,
    },
    {
      response: () => sseResponse([
        JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [{
            id: 'call_0000000000000001',
            type: 'function',
            function: { name: 'workspace_list', arguments: '{"limit":5}' },
          }] } }],
        }),
        chunk('answer'),
      ]),
      message: /mixed tool-call response/,
    },
    {
      response: () => sseResponse(['{invalid']),
      message: /invalid stream JSON/,
    },
    {
      response: () => sseResponse([chunk(null)]),
      message: /empty completion/,
    },
    {
      response: () => sseResponse([chunk('x'.repeat(STREAMING_OUTPUT_LIMITS.chunkCharacters + 1))]),
      message: /oversized output chunk/,
    },
  ];

  for (const item of cases) {
    const provider = new OpenAiChatCompletionsProvider({
      ...config,
      fetch: async () => item.response(),
    });
    await assert.rejects(
      provider.streamTurn({
        taskId: 'task_fixture',
        prompt: 'hello',
        turnIndex: 0,
        onOutputDelta: () => undefined,
      }),
      (cause: unknown) => cause instanceof ModelProviderError
        && item.message.test(cause.message),
    );
  }
});

test('the streaming provider rejects HTTP errors and truncated streams', async () => {
  const httpError = new OpenAiChatCompletionsProvider({
    ...config,
    fetch: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(
    httpError.streamTurn({
      taskId: 'task_fixture',
      prompt: 'hello',
      turnIndex: 0,
      onOutputDelta: () => undefined,
    }),
    /HTTP 503/,
  );

  const truncated = new OpenAiChatCompletionsProvider({
    ...config,
    fetch: async () => new Response('data: ' + chunk('hello') + '\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  });
  await assert.rejects(
    truncated.streamTurn({
      taskId: 'task_fixture',
      prompt: 'hello',
      turnIndex: 0,
      onOutputDelta: () => undefined,
    }),
    /ended before completion/,
  );
});

test('the streaming provider forwards cancellation to the response stream', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const provider = new OpenAiChatCompletionsProvider({
    ...config,
    fetch: async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('data: ' + chunk('partial') + '\n\n'));
          controller.abort();
          streamController.close();
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  await assert.rejects(
    provider.streamTurn({
      taskId: 'task_fixture',
      prompt: 'hello',
      turnIndex: 0,
      signal: controller.signal,
      onOutputDelta: () => undefined,
    }),
  );
  assert.equal(observedSignal?.aborted, true);
});
