import assert from 'node:assert/strict';
import test from 'node:test';
import { categorizeError, formatErrorLog, safeMessage, safeTaskError, toErrorRecord } from '../src/runtime/error-categories.js';
import { ProviderError } from '../src/runtime/model-provider.js';

/**
 * A provider error already knows what went wrong.
 *
 * The adapter classifies a 401 as `authentication`, a 429 as `rate-limit`, and
 * an unreachable gateway as `unavailable`. Folding that back into "the provider
 * returned something" loses the one fact an operator needs: whether to fix a
 * credential, wait, or change an address. These cases were found by running a
 * task against an endpoint that answered 401.
 */
test('a classified provider error keeps its category', () => {
  assert.equal(categorizeError(new ProviderError('authentication', 'Model provider returned HTTP 401.')), 'auth');
  assert.equal(categorizeError(new ProviderError('rate-limit', 'slow down')), 'rate-limit');
  assert.equal(categorizeError(new ProviderError('timeout', 'timed out')), 'timeout');
  assert.equal(categorizeError(new ProviderError('unavailable', 'endpoint is down')), 'unavailable');
  assert.equal(categorizeError(new ProviderError('upstream-failure', 'HTTP 500')), 'provider');
  assert.equal(categorizeError(new ProviderError('invalid-request', 'bad body')), 'validation');
  assert.equal(categorizeError(new ProviderError('context-limit', 'too long')), 'validation');
});

test('a transport failure is retryable and reported as unavailable', async () => {
  const { ModelProviderError, OpenAiChatCompletionsProvider } = await import('../src/runtime/magpie-provider.js');
  const provider = new OpenAiChatCompletionsProvider({
    baseUrl: 'http://127.0.0.1:9',
    model: 'x',
    appKeyFormat: 'opaque',
    fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => provider.streamTurn({ taskId: 't', turnIndex: 0, prompt: 'hi', onOutputDelta: () => undefined }),
    (error: unknown) => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.kind, 'unavailable');
      assert.equal(error.retryable, true);
      assert.equal(categorizeError(error), 'unavailable');
      return true;
    },
  );
});

test('known error names map to categories', () => {
  assert.equal(categorizeError({ name: 'TaskValidationError', message: 'prompt must be a non-empty string.' }), 'validation');
  assert.equal(categorizeError({ name: 'TaskNotFoundError', message: 'Task not found.' }), 'not-found');
  assert.equal(categorizeError({ name: 'TaskConflictError', message: 'Task is not queued.' }), 'conflict');
  assert.equal(categorizeError(new Error('Agent loop exceeded its time budget.')), 'timeout');
  assert.equal(categorizeError({ statusCode: 429, message: 'slow down' }), 'rate-limit');
  assert.equal(categorizeError({ statusCode: 502, message: 'bad gateway' }), 'provider');
  assert.equal(categorizeError('something exploded'), 'internal');
});

test('status codes follow the category', () => {
  assert.equal(toErrorRecord({ name: 'TaskValidationError', message: 'x' }).status, 400);
  assert.equal(toErrorRecord({ name: 'TaskNotFoundError', message: 'x' }).status, 404);
  assert.equal(toErrorRecord(new Error('boom')).status, 500);
});

test('control characters are stripped and length is bounded', () => {
  const messy = `line1\u0000line2\u001b ${'x'.repeat(500)}`;
  const clean = safeMessage(messy, 50);
  assert.equal(clean.includes('\u0000'), false);
  assert.equal(clean.length <= 50, true);
});

test('durable task error text withholds secret-like details', () => {
  const safe = safeTaskError(new Error('credential sk-abcdefghijklmnop was rejected'));
  assert.equal(safe.includes('sk-abcdefghijklmnop'), false);
  assert.match(safe, /withheld/i);
  assert.equal(safeTaskError(new Error('plain failure')), 'plain failure');
});

test('the log line carries identifiers but never raw prompts or arguments', () => {
  const record = toErrorRecord(
    new Error('Task failed while running prompt "SECRET PROMPT"'),
    { requestId: 'req-1', taskId: 'task-9', attempt: 2 },
  );
  const line = formatErrorLog(record);
  const parsed = JSON.parse(line);
  assert.equal(parsed.category, 'internal');
  assert.equal(parsed.requestId, 'req-1');
  assert.equal(parsed.taskId, 'task-9');
  assert.equal(parsed.attempt, 2);
  assert.equal(line.includes('SECRET PROMPT'), false, 'log must not contain prompt text');
  for (const key of ['prompt', 'arguments', 'output', 'messages', 'transcript']) {
    assert.equal(key in parsed, false, `log must not contain ${key}`);
  }
});
