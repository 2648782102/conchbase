import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalString, requiredString } from '../src/runtime/tool-parameter.js';
import { ToolRejectedError } from '../src/runtime/tool-provider.js';

/**
 * Two shapes, one name each.
 *
 * Before this module the same reader existed under three names with two
 * behaviours, so a caller could not tell which contract it was getting without
 * opening the file. The distinction the tests pin is exactly the one that was
 * ambiguous: absent-with-fallback versus absent-is-an-error.
 */

function rejected(cause: unknown): boolean {
  return cause instanceof ToolRejectedError && cause.code === 'invalid_arguments';
}

test('requiredString returns a present, non-empty string', () => {
  assert.equal(requiredString({ path: 'a.txt' }, 'path'), 'a.txt');
});

test('requiredString refuses an absent key', () => {
  assert.throws(() => requiredString({}, 'path'), rejected);
});

test('requiredString refuses an empty string', () => {
  assert.throws(() => requiredString({ path: '' }, 'path'), rejected);
});

test('requiredString refuses a non-string instead of coercing it', () => {
  // A model sending {"path": 5} is a mistake worth surfacing.
  assert.throws(() => requiredString({ path: 5 }, 'path'), rejected);
});

test('requiredString names the caller-supplied label in the error', () => {
  assert.throws(
    () => requiredString({}, 'path', 'file path'),
    (cause: unknown) => rejected(cause) && /file path/.test((cause as Error).message),
  );
});

test('optionalString returns the fallback only when the key is absent', () => {
  assert.equal(optionalString({}, 'path', '.'), '.');
  assert.equal(optionalString({}, 'path'), '');
  assert.equal(optionalString({ path: '' }, 'path', '.'), '', 'an explicit empty is not absent');
});

test('optionalString still refuses a non-string', () => {
  assert.throws(() => optionalString({ path: 5 }, 'path'), rejected);
  assert.throws(() => optionalString({ path: null }, 'path'), rejected);
});
