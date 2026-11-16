import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BossModeServiceError,
  boundedError,
  digest,
  intentId,
  reference,
  validateSubmission,
} from '../src/runtime/organization-intent-input.js';

/**
 * Intent admission.
 *
 * Everything here runs before any organisation state is touched. A regression
 * means untrusted input reaches execution, so the rules are asserted directly
 * rather than only through the service.
 */

test('a minimal valid submission is accepted and frozen', () => {
  const submission = validateSubmission({ text: '开个项目', idempotencyKey: 'k1' });
  assert.equal(submission.text, '开个项目');
  assert.ok(Object.isFrozen(submission));
});

test('unknown fields are rejected, not silently dropped', () => {
  // Dropping would hide a client or model whose mental model is wrong.
  assert.throws(
    () => validateSubmission({ text: 'x', idempotencyKey: 'k', surprise: 1 }),
    /Unknown fields: surprise/,
  );
});

test('text and idempotency key are bounded', () => {
  assert.throws(() => validateSubmission({ text: '', idempotencyKey: 'k' }), BossModeServiceError);
  assert.throws(() => validateSubmission({ text: '   ', idempotencyKey: 'k' }), BossModeServiceError);
  assert.throws(() => validateSubmission({ text: 'x'.repeat(20_001), idempotencyKey: 'k' }), BossModeServiceError);
  assert.throws(() => validateSubmission({ text: 'x', idempotencyKey: '' }), BossModeServiceError);
  assert.throws(() => validateSubmission({ text: 'x', idempotencyKey: 'k'.repeat(201) }), BossModeServiceError);
});

test('secret-like content is refused at admission', () => {
  assert.throws(
    () => validateSubmission({ text: 'use sk-abcdef123456 please', idempotencyKey: 'k' }),
    /secret-like/,
  );
});

test('conversation context is bounded in length and per message', () => {
  const tooMany = Array.from({ length: 9 }, () => ({ author: 'user', body: 'hi' }));
  assert.throws(() => validateSubmission({ text: 'x', idempotencyKey: 'k', conversation: tooMany }), /at most 8/);
  assert.throws(
    () => validateSubmission({
      text: 'x', idempotencyKey: 'k', conversation: [{ author: 'user', body: 'y'.repeat(6001) }],
    }),
    /bounded safe message/,
  );
  const accepted = validateSubmission({
    text: 'x', idempotencyKey: 'k',
    conversation: [{ author: 'assistant', body: '好的' }],
  });
  assert.equal(accepted.conversation?.length, 1);
});

test('model override and reasoning effort are shape-checked', () => {
  assert.throws(
    () => validateSubmission({ text: 'x', idempotencyKey: 'k', modelOverride: { providerId: 'magpie' } }),
    /providerId and modelId/,
  );
  assert.throws(
    () => validateSubmission({ text: 'x', idempotencyKey: 'k', reasoningEffort: 'extreme' }),
    /reasoningEffort/,
  );
  const accepted = validateSubmission({
    text: 'x', idempotencyKey: 'k',
    modelOverride: { providerId: 'magpie', modelId: 'm' },
    reasoningEffort: 'high',
  });
  assert.equal(accepted.reasoningEffort, 'high');
  assert.deepEqual(accepted.modelOverride, { providerId: 'magpie', modelId: 'm' });
});

test('derived identities are stable and prefixed', () => {
  assert.equal(digest('a'), digest('a'));
  assert.notEqual(digest('a'), digest('b'));
  assert.match(digest('a'), /^sha256:[0-9a-f]{64}$/);
  assert.match(reference('a'), /^[0-9a-f]{24}$/);
  assert.match(reference('a', 8), /^[0-9a-f]{8}$/);
  assert.match(intentId('key-1'), /^int_[0-9a-f]{24}$/);
  assert.equal(intentId('key-1'), intentId('key-1'));
});

test('boundedError keeps a diagnostic for non-Error throwables', () => {
  // Collapsing these into "unknown failure" previously hid real causes.
  assert.match(boundedError(new Error('boom')), /boom/);
  assert.match(boundedError('plain string'), /plain string/);
  assert.match(boundedError({ code: 42 }), /42/);
  assert.equal(boundedError(''), 'Unknown execution failure.');
  assert.ok(boundedError('x'.repeat(1_000)).length <= 240);
  assert.doesNotMatch(boundedError('bad\u0000value'), /\u0000/);
});
