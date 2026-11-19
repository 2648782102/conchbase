import assert from 'node:assert/strict';
import test from 'node:test';
import { categorizeError, formatErrorLog, safeMessage, toErrorRecord } from '../src/runtime/error-categories.js';

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
