import assert from 'node:assert/strict';
import test from 'node:test';
import { contentDigest, referenceDigest } from '../src/runtime/digest.js';

/**
 * Both shapes are identity keys somewhere in the product.
 *
 * `contentDigest` is the evidence attached to a tool result; `referenceDigest`
 * names an event or receipt. If either silently changed — a different hash, a
 * different truncation — the features that compare digests would stop matching
 * without failing loudly, so the exact output is pinned here.
 */

test('contentDigest is the full sha256 prefixed form', () => {
  assert.equal(
    contentDigest('hello'),
    'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  assert.match(contentDigest('hello'), /^sha256:[0-9a-f]{64}$/);
});

test('referenceDigest is a 24-character hex suffix after the prefix', () => {
  const digest = referenceDigest('evt', 'hello');
  assert.match(digest, /^evt_[0-9a-f]{24}$/);
  // Deterministic, so the same input is always the same identity.
  assert.equal(digest, referenceDigest('evt', 'hello'));
});

test('different prefixes over the same value are distinct identities', () => {
  assert.notEqual(referenceDigest('evt', 'x'), referenceDigest('rpt', 'x'));
});

test('different values under one prefix are distinct identities', () => {
  assert.notEqual(referenceDigest('evt', 'a'), referenceDigest('evt', 'b'));
});

test('the two shapes never collide in form', () => {
  // A content digest is never parseable as a reference digest and vice versa.
  assert.notEqual(contentDigest('x').startsWith('evt_'), true);
  assert.equal(referenceDigest('sha256', 'x').startsWith('sha256:'), false);
});
