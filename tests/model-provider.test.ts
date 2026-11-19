import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, classifyProviderFailure } from '../src/runtime/model-provider.js';

test('http failures map to provider kinds', () => {
  assert.equal(classifyProviderFailure(401, ''), 'authentication');
  assert.equal(classifyProviderFailure(403, ''), 'authentication');
  assert.equal(classifyProviderFailure(429, ''), 'rate-limit');
  assert.equal(classifyProviderFailure(408, ''), 'timeout');
  assert.equal(classifyProviderFailure(400, 'maximum context length exceeded'), 'context-limit');
  assert.equal(classifyProviderFailure(400, 'bad schema'), 'invalid-request');
  assert.equal(classifyProviderFailure(404, ''), 'invalid-request');
  assert.equal(classifyProviderFailure(503, ''), 'upstream-failure');
  assert.equal(classifyProviderFailure(200, 'token limit reached'), 'context-limit');
});

test('provider errors expose retryability by kind', () => {
  assert.equal(new ProviderError('rate-limit', 'x').retryable, true);
  assert.equal(new ProviderError('timeout', 'x').retryable, true);
  assert.equal(new ProviderError('unavailable', 'x').retryable, true);
  assert.equal(new ProviderError('authentication', 'x').retryable, false);
  assert.equal(new ProviderError('invalid-request', 'x').retryable, false);
  assert.equal(new ProviderError('context-limit', 'x').retryable, false);
  assert.equal(new ProviderError('upstream-failure', 'x').retryable, false);
});

test('an explicit retryable override wins', () => {
  assert.equal(new ProviderError('upstream-failure', 'x', { retryable: true }).retryable, true);
  assert.equal(new ProviderError('rate-limit', 'x', { retryable: false }).retryable, false);
});

test('a magpie 429 surfaces as a retryable rate-limit error', async () => {
  const { OpenAiChatCompletionsProvider, ModelProviderError } = await import('../src/runtime/magpie-provider.js');
  const provider = new OpenAiChatCompletionsProvider({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/model',
    fetch: (async () => new Response('slow down', { status: 429 })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => provider.nextTurn({ taskId: 't', prompt: 'x', turnIndex: 0 }),
    (cause: unknown) => cause instanceof ModelProviderError
      && cause.kind === 'rate-limit'
      && cause.retryable === true,
  );
});

test('a magpie 401 surfaces as a non-retryable auth error', async () => {
  const { OpenAiChatCompletionsProvider, ModelProviderError } = await import('../src/runtime/magpie-provider.js');
  const provider = new OpenAiChatCompletionsProvider({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/model',
    fetch: (async () => new Response('no key', { status: 401 })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => provider.nextTurn({ taskId: 't', prompt: 'x', turnIndex: 0 }),
    (cause: unknown) => cause instanceof ModelProviderError
      && cause.kind === 'authentication'
      && cause.retryable === false,
  );
});
