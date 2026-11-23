import assert from 'node:assert/strict';
import test from 'node:test';
import { containsSecretLike } from '../src/runtime/secret-filter.js';

test('provider tokens and credential words are detected', () => {
  // This filter is the last line of defence before text reaches a prompt, a
  // memory entry, a report, or a log. A false negative leaks a credential.
  for (const value of [
    'sk-abcdef123456',
    'Authorization: Bearer abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuvwx',
    'github_pat_abcdefghijklmnopqrstuv',
    'password: hunter2',
    'apiKey = abc',
    'privateKey: x',
  ]) {
    assert.equal(containsSecretLike(value), true, `must detect: ${value}`);
  }
});

test('private runtime paths are treated as sensitive', () => {
  for (const value of ['.conchbase/runtime.sqlite', 'open .conchbase/state']) {
    assert.equal(containsSecretLike(value), true, `must detect: ${value}`);
  }
});

test('ordinary prose is not flagged', () => {
  // The filter runs on every published string. Over-matching would make normal
  // conversation impossible, so false positives matter as much as misses.
  for (const value of [
    '先给一句话结论，再给证据。',
    'The task finished successfully.',
    'task_1234 completed',
    'description: 写作规范',
    'risk assessment done',
    '',
  ]) {
    assert.equal(containsSecretLike(value), false, `must not flag: ${JSON.stringify(value)}`);
  }
});

test('null and undefined are safe inputs', () => {
  assert.equal(containsSecretLike(null), false);
  assert.equal(containsSecretLike(undefined), false);
});

test('a token embedded in a longer string is still detected', () => {
  // Credentials arrive inside larger payloads, not as bare strings.
  assert.equal(containsSecretLike('use this key: sk-abcd1234 for the call'), true);
  assert.equal(containsSecretLike('header was Bearer abcdefghijklmnopqrst'), true);
});

test('short secret tokens and credential words share one runtime filter', () => {
  for (const value of [
    'credential sk-ab was rejected',
    'denied: ghp_shorttoken',
    'header github_pat_shorttoken',
    'api_key: value',
  ]) {
    assert.equal(containsSecretLike(value), true, `must detect: ${value}`);
  }
});

test('ordinary prose about secrets is not automatically withheld', () => {
  for (const value of [
    'Describe the secret handshake used by the team.',
    'The credential flow needs an operator decision.',
    'This document explains API key rotation.',
  ]) {
    assert.equal(containsSecretLike(value), false, `must not flag: ${value}`);
  }
});
