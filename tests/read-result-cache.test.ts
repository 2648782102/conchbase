import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadResultCache } from '../src/runtime/read-result-cache.js';
import { digestArguments } from '../src/runtime/tool-arguments.js';

test('argument digests are order-independent and stable', () => {
  // Reuse and durable event identity both depend on this: two digests that
  // differ only by key order would defeat deduplication.
  assert.equal(digestArguments({ a: 1, b: 2 }), digestArguments({ b: 2, a: 1 }));
  assert.notEqual(digestArguments({ a: 1 }), digestArguments({ a: 2 }));
  assert.match(digestArguments({}), /^arg_[0-9a-f]{24}$/);
});

test('argument digests cannot be confused by a delimiter inside a value', () => {
  // Naive `key=value&` concatenation made these two calls share one identity,
  // which would let "this write already ran" answer for a different write.
  assert.notEqual(
    digestArguments({ a: '1&b=2' }),
    digestArguments({ a: '1', b: '2' }),
  );
  assert.notEqual(digestArguments({ a: '1' }), digestArguments({ a: 1 }));
});

test('an identical read in the same attempt is reused', () => {
  const cache = new ReadResultCache();
  cache.set('task_1', 1, 'workspace_read', { path: 'a.txt' }, { summary: 'content', digest: 'sha256:1' });
  assert.deepEqual(
    cache.get('task_1', 1, 'workspace_read', { path: 'a.txt' }),
    { summary: 'content', digest: 'sha256:1' },
  );
});

test('a different attempt never reuses the previous attempt result', () => {
  // A retry must observe fresh data, not a stale copy.
  const cache = new ReadResultCache();
  cache.set('task_1', 1, 'workspace_read', { path: 'a.txt' }, { summary: 'old', digest: 'sha256:1' });
  assert.equal(cache.get('task_1', 2, 'workspace_read', { path: 'a.txt' }), undefined);
});

test('different arguments or tools do not collide', () => {
  const cache = new ReadResultCache();
  cache.set('task_1', 1, 'workspace_read', { path: 'a.txt' }, { summary: 'a', digest: 'sha256:1' });
  assert.equal(cache.get('task_1', 1, 'workspace_read', { path: 'b.txt' }), undefined);
  assert.equal(cache.get('task_1', 1, 'text_search', { path: 'a.txt' }), undefined);
});

test('clearing one task leaves other tasks intact', () => {
  const cache = new ReadResultCache();
  cache.set('task_1', 1, 't', { p: 1 }, { summary: 'a', digest: 'sha256:1' });
  cache.set('task_2', 1, 't', { p: 1 }, { summary: 'b', digest: 'sha256:2' });
  cache.clear('task_1');
  assert.equal(cache.get('task_1', 1, 't', { p: 1 }), undefined);
  assert.ok(cache.get('task_2', 1, 't', { p: 1 }));
});
