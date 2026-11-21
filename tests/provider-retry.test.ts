import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RETRY_POLICY,
  RetryExhaustedError,
  retryDelayMs,
  retryableKind,
  withProviderRetry,
} from '../src/runtime/provider-retry.js';
import { ProviderError } from '../src/runtime/model-provider.js';
import { ModelProviderError } from '../src/runtime/magpie-provider.js';

const noSleep = async () => undefined;

test('only failures the adapter marked retryable are retried', () => {
  assert.equal(retryableKind(new ProviderError('rate-limit', 'slow down')), 'rate-limit');
  assert.equal(retryableKind(new ProviderError('timeout', 'timed out')), 'timeout');
  assert.equal(retryableKind(new ModelProviderError('unreachable', 'unavailable')), 'unavailable');
  // Deterministic failures must fail fast: the same call gives the same answer.
  assert.equal(retryableKind(new ProviderError('authentication', 'bad key')), null);
  assert.equal(retryableKind(new ProviderError('invalid-request', 'bad body')), null);
  assert.equal(retryableKind(new ProviderError('context-limit', 'too long')), null);
  assert.equal(retryableKind(new Error('unrelated')), null);
});

test('backoff grows exponentially and is capped', () => {
  const policy = { attempts: 5, baseDelayMs: 100, maxDelayMs: 500 };
  assert.equal(retryDelayMs(1, policy), 100);
  assert.equal(retryDelayMs(2, policy), 200);
  assert.equal(retryDelayMs(3, policy), 400);
  assert.equal(retryDelayMs(4, policy), 500, 'the cap holds');
  assert.equal(retryDelayMs(9, policy), 500);
});

test('a transient failure is survived and reported', async () => {
  let calls = 0;
  const retries: string[] = [];
  const outcome = await withProviderRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new ProviderError('rate-limit', 'slow down');
      return 'answered';
    },
    { sleep: noSleep, onRetry: ({ kind }) => retries.push(kind) },
  );
  assert.equal(outcome.value, 'answered');
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(outcome.recovered, ['rate-limit', 'rate-limit']);
  assert.deepEqual(retries, ['rate-limit', 'rate-limit']);
});

test('a deterministic failure is never retried', async () => {
  let calls = 0;
  await assert.rejects(
    withProviderRetry(async () => {
      calls += 1;
      throw new ProviderError('authentication', 'bad key');
    }, { sleep: noSleep }),
    /bad key/,
  );
  assert.equal(calls, 1, 'an auth failure must reach the user on the first attempt');
});

test('exhausting the budget reports how many attempts were made', async () => {
  let calls = 0;
  await assert.rejects(
    withProviderRetry(async () => {
      calls += 1;
      throw new ProviderError('unavailable', 'gateway down');
    }, { sleep: noSleep }),
    (cause: unknown) => {
      assert.ok(cause instanceof RetryExhaustedError);
      assert.equal(cause.attempts, DEFAULT_RETRY_POLICY.attempts);
      assert.equal(cause.kind, 'unavailable');
      assert.match(cause.message, /已尝试 3 次/);
      return true;
    },
  );
  assert.equal(calls, DEFAULT_RETRY_POLICY.attempts);
});

test('cancelling the caller stops the retry loop', async () => {
  const controller = new AbortController();
  let calls = 0;
  const running = withProviderRetry(
    async () => {
      calls += 1;
      throw new ProviderError('timeout', 'timed out');
    },
    {
      signal: controller.signal,
      // A real sleep is used so the abort lands during the backoff.
      sleep: async (ms, signal) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      }),
    },
  );
  controller.abort();
  await assert.rejects(running, /aborted/i);
  assert.ok(calls <= 1, 'no further attempt may start after the stop');
});
