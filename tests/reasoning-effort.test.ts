import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultEffort,
  effortRank,
  KNOWN_EFFORTS,
  parseEffortToken,
  sortEfforts,
  supportsEffort,
} from '../src/runtime/reasoning-effort.js';

test('effort tokens are trimmed, bounded, and normalized', () => {
  assert.equal(parseEffortToken(undefined), undefined);
  assert.equal(parseEffortToken(null), undefined);
  assert.equal(parseEffortToken('  high  '), 'high');
  assert.equal(parseEffortToken(''), undefined);
  assert.throws(() => parseEffortToken(5), /must be a string/);
  assert.throws(() => parseEffortToken('HIGH'), /lowercase token/);
  assert.throws(() => parseEffortToken('x'.repeat(33)), /lowercase token/);
});

test('published efforts sort by known strength and preserve unknown order', () => {
  assert.deepEqual(
    [...sortEfforts(['max', 'unknown-b', 'low', 'unknown-a', 'xhigh'])],
    ['low', 'xhigh', 'max', 'unknown-b', 'unknown-a'],
  );
  assert.equal(effortRank('low'), KNOWN_EFFORTS.indexOf('low'));
  assert.equal(effortRank('future'), KNOWN_EFFORTS.length);
  assert.equal(supportsEffort(['low', 'high'], 'high'), true);
  assert.equal(supportsEffort(undefined, 'high'), false);
});

test('the default effort skips none and picks the middle remaining step', () => {
  assert.equal(defaultEffort(['none', 'low', 'high', 'max']), 'high');
  assert.equal(defaultEffort(['low', 'medium', 'high']), 'medium');
  assert.equal(defaultEffort(['none']), 'none');
  assert.equal(defaultEffort([]), undefined);
});
