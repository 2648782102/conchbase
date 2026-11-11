import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import {
  ModelProviderError,
  OpenAiChatCompletionsProvider,
  STREAMING_OUTPUT_LIMITS,
} from '../src/runtime/magpie-provider.js';
import { MagpieModelCatalog } from '../src/runtime/model-catalog.js';
import type { ModelCatalogEntry } from '../src/runtime/model-catalog.js';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

interface ConformanceReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

type Responder = (request: RecordedRequest) => ConformanceReply;

function jsonReply(payload: unknown, status = 200): ConformanceReply {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function sseChunk(content: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    choices: [{ delta: { content, ...extra }, finish_reason: null }],
  });
}

function sseReply(frames: readonly string[], status = 200): ConformanceReply {
  return {
    status,
    headers: { 'content-type': 'text/event-stream' },
    body: frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n',
  };
}

async function withConformanceServer(
  responder: Responder,
  run: (baseUrl: string, requests: readonly RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) as Record<string, unknown> : {};
      } catch {
        body = {};
      }
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
      };
      requests.push(recorded);
      const reply = responder(recorded);
      response.writeHead(reply.status ?? 200, reply.headers ?? {});
      response.end(reply.body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('the provider compatibility fixture covers catalog, non-streaming, and streaming shapes', async () => {
  const responder: Responder = (request) => {
    if (request.path === '/v1/models') {
      return jsonReply({
        data: [
          { id: 'fixture/model', display_name: 'Fixture Model' },
          { id: 'fixture/other' },
          { id: '' },
          null,
        ],
      });
    }
    if (request.path !== '/v1/chat/completions') return jsonReply({ error: 'not found' }, 404);
    if (request.body.stream === true) {
      return sseReply([
        sseChunk(null, { reasoning_content: 'ignored' }),
        sseChunk('hello'),
        sseChunk(' world'),
      ]);
    }
    return jsonReply({
      choices: [{ message: { content: 'non-streaming answer' } }],
    });
  };

  await withConformanceServer(responder, async (baseUrl, requests) => {
    const catalog = new MagpieModelCatalog({
      baseUrl,
      appKey: 'magpie-conchbase-fixture',
    });
    const models: readonly ModelCatalogEntry[] = await catalog.listModels();
    assert.deepEqual(models, [
      { id: 'fixture/model', displayName: 'Fixture Model' },
      { id: 'fixture/other', displayName: 'fixture/other' },
    ]);

    const provider = new OpenAiChatCompletionsProvider({
      baseUrl,
      model: 'fixture/model',
      appKey: 'magpie-conchbase-fixture',
    });
    const structured = await provider.nextTurn({
      taskId: 'task_conformance',
      prompt: 'hello',
      turnIndex: 0,
    });
    assert.deepEqual(structured, { kind: 'final', output: 'non-streaming answer' });

    const deltas: string[] = [];
    const streaming = await provider.streamTurn({
      taskId: 'task_conformance',
      prompt: 'hello',
      turnIndex: 0,
      onOutputDelta: (delta) => deltas.push(delta),
    });
    assert.deepEqual(streaming, { kind: 'final', output: 'hello world' });
    assert.deepEqual(deltas, ['hello', ' world']);

    assert.equal(requests.length, 3);
    const [catalogRequest, structuredRequest, streamingRequest] = requests;
    assert.equal(catalogRequest?.method, 'GET');
    assert.equal(catalogRequest?.path, '/v1/models');
    assert.equal(catalogRequest?.headers.authorization, 'Bearer magpie-conchbase-fixture');
    assert.equal(structuredRequest?.method, 'POST');
    assert.equal(structuredRequest?.path, '/v1/chat/completions');
    assert.equal(structuredRequest?.headers.accept, 'application/json');
    assert.equal(structuredRequest?.body.stream, false);
    assert.equal(structuredRequest?.body.model, 'fixture/model');
    assert.equal(streamingRequest?.headers.accept, 'text/event-stream');
    assert.equal(streamingRequest?.body.stream, true);
    assert.deepEqual(streamingRequest?.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.ok(requests.every((entry) => entry.headers.authorization === 'Bearer magpie-conchbase-fixture'));
  });
});

test('the provider compatibility fixture normalizes observations, errors, limits, and cancellation', async () => {
  const responder: Responder = (request) => {
    if (request.body.model === 'fixture/unavailable') return jsonReply({ error: 'unavailable' }, 503);
    if (request.body.model === 'fixture/oversized') {
      return sseReply([sseChunk('x'.repeat(STREAMING_OUTPUT_LIMITS.chunkCharacters + 1))]);
    }
    if (request.body.model === 'fixture/truncated') {
      return {
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${sseChunk('partial')}\n\n`,
      };
    }
    if (request.body.stream === true) {
      return sseReply([JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_conformance',
              type: 'function',
              function: {
                name: 'fixture_read',
                arguments: JSON.stringify({ value: 'bounded' }),
              },
            }],
          },
        }],
      })]);
    }
    return jsonReply({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_conformance',
            type: 'function',
            function: {
              name: 'fixture_read',
              arguments: JSON.stringify({ value: 'bounded' }),
            },
          }],
        },
      }],
    });
  };

  await withConformanceServer(responder, async (baseUrl) => {
    const config = { baseUrl, model: 'fixture/model', appKey: 'magpie-conchbase-fixture' };
    const observationProvider = new OpenAiChatCompletionsProvider(config);
    const observation = await observationProvider.nextTurn({
      taskId: 'task_conformance',
      prompt: 'hello',
      turnIndex: 0,
    });
    assert.equal(observation.kind, 'tool_call_observation');

    const streamingObservation = await observationProvider.streamTurn({
      taskId: 'task_conformance',
      prompt: 'hello',
      turnIndex: 0,
      onOutputDelta: () => assert.fail('tool-call observation must not emit answer deltas'),
    });
    assert.equal(streamingObservation.kind, 'tool_call_observation');
    if (streamingObservation.kind === 'tool_call_observation') {
      assert.deepEqual(streamingObservation.observation.toolCall, {
        toolName: 'fixture_read',
        arguments: { value: 'bounded' },
      });
    }

    const unavailable = new OpenAiChatCompletionsProvider({ ...config, model: 'fixture/unavailable' });
    await assert.rejects(
      unavailable.nextTurn({ taskId: 'task_conformance', prompt: 'hello', turnIndex: 0 }),
      (cause: unknown) => cause instanceof ModelProviderError && /HTTP 503/.test(cause.message),
    );

    const oversized = new OpenAiChatCompletionsProvider({ ...config, model: 'fixture/oversized' });
    await assert.rejects(
      oversized.streamTurn({
        taskId: 'task_conformance',
        prompt: 'hello',
        turnIndex: 0,
        onOutputDelta: () => undefined,
      }),
      /oversized output chunk/,
    );

    const truncated = new OpenAiChatCompletionsProvider({ ...config, model: 'fixture/truncated' });
    await assert.rejects(
      truncated.streamTurn({
        taskId: 'task_conformance',
        prompt: 'hello',
        turnIndex: 0,
        onOutputDelta: () => undefined,
      }),
      /ended before completion/,
    );

    const controller = new AbortController();
    const cancelProvider = new OpenAiChatCompletionsProvider({
      ...config,
      fetch: async (_url, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        controller.abort();
        assert.equal(signal?.aborted, true);
        return new Response('', { status: 503 });
      },
    });
    await assert.rejects(
      cancelProvider.streamTurn({
        taskId: 'task_conformance',
        prompt: 'hello',
        turnIndex: 0,
        signal: controller.signal,
        onOutputDelta: () => undefined,
      }),
    );

    assert.throws(
      () => new OpenAiChatCompletionsProvider({ ...config, baseUrl: 'https://example.com' }),
      /loopback base URL/,
    );
  });
});
