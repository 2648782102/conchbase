import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OrganizationValidationError,
  boundedDigest,
  boundedInteger,
  boundedString,
  digest,
  opaqueId,
  opaqueReference,
  parseCapabilities,
  parseModel,
  parseScope,
  rejectSecretLike,
} from '../src/runtime/organization-validators.js';

/**
 * Field-level validation for organization actions.
 *
 * These are the rules that keep an action bounded, opaque, and free of
 * credentials. They are asserted here rather than only through a full action
 * parse so a loosened bound is visible immediately.
 */

test('strings are bounded and whitespace-significant', () => {
  assert.equal(boundedString('ok', 'x'), 'ok');
  assert.throws(() => boundedString('', 'x'), OrganizationValidationError);
  assert.throws(() => boundedString(' padded ', 'x'), OrganizationValidationError);
  assert.throws(() => boundedString('x'.repeat(241), 'x'), OrganizationValidationError);
  assert.throws(() => boundedString(1, 'x'), OrganizationValidationError);
});

test('opaque references and digests have their own grammars', () => {
  assert.equal(opaqueReference('project_1', 'id'), 'project_1');
  assert.throws(() => opaqueReference('Project-1', 'id'), /opaque reference/);
  assert.throws(() => opaqueReference('project 1', 'id'), /opaque reference/);
  assert.equal(boundedDigest('sha256:abc', 'd'), 'sha256:abc');
  assert.throws(() => boundedDigest('SHA256:abc', 'd'), /opaque digest/);
});

test('integers are bounded inclusively', () => {
  assert.equal(boundedInteger(3, 'n', 1, 5), 3);
  assert.equal(boundedInteger(1, 'n', 1, 5), 1);
  assert.equal(boundedInteger(5, 'n', 1, 5), 5);
  assert.throws(() => boundedInteger(0, 'n', 1, 5), OrganizationValidationError);
  assert.throws(() => boundedInteger(6, 'n', 1, 5), OrganizationValidationError);
  assert.throws(() => boundedInteger(1.5, 'n', 1, 5), OrganizationValidationError);
  assert.throws(() => boundedInteger('2', 'n', 1, 5), OrganizationValidationError);
});

test('scope entries are scoped and duplicates are refused', () => {
  // Duplicates are rejected rather than merged: a repeated scope is a sign the
  // caller built the action wrong, and silently normalising it hides that.
  assert.deepEqual([...parseScope(['project:a/b', 'project:c'])], ['project:a/b', 'project:c']);
  assert.throws(() => parseScope(['project:a/b', 'project:a/b']), /duplicates/);
  assert.throws(() => parseScope([]), OrganizationValidationError);
  // A bare token is legal; a path escape or absolute path is not.
  assert.deepEqual([...parseScope(['anything'])], ['anything']);
  assert.throws(() => parseScope(['/etc/passwd']), OrganizationValidationError);
  assert.throws(() => parseScope(['project/../secret']), OrganizationValidationError);
});

test('capabilities must be well-formed tokens without duplicates', () => {
  assert.deepEqual([...parseCapabilities(['cap_read_context'])], ['cap_read_context']);
  assert.throws(() => parseCapabilities(['read']), OrganizationValidationError);
  assert.throws(
    () => parseCapabilities(['cap_read_context', 'cap_read_context']),
    /duplicates/,
  );
});

test('a model reference is provider-neutral and bounded', () => {
  assert.deepEqual(parseModel({ providerId: 'magpie', modelId: 'm' }), { providerId: 'magpie', modelId: 'm' });
  assert.throws(() => parseModel({ providerId: 'magpie' }), OrganizationValidationError);
  assert.throws(() => parseModel({ providerId: 'magpie', modelId: 'm', extra: 1 }), OrganizationValidationError);
});

test('secret-like keys and values are refused at any depth', () => {
  assert.throws(() => rejectSecretLike({ apiKey: 'x' }), OrganizationValidationError);
  assert.throws(() => rejectSecretLike({ nested: [{ password: 'x' }] }), OrganizationValidationError);
  assert.throws(() => rejectSecretLike('token sk-abcdef123456'), /secret-like/);
  assert.doesNotThrow(() => rejectSecretLike({ note: '普通文本' }));
});

test('identities are canonical and order-independent', () => {
  // Two actions that differ only by key order must produce the same identity,
  // otherwise replay and deduplication break.
  assert.equal(digest('k', { a: 1, b: 2 }), digest('k', { b: 2, a: 1 }));
  assert.match(opaqueId('project', { x: 1 }), /^project_[0-9a-f]{24}$/);
  assert.notEqual(digest('k', { a: 1 }), digest('k', { a: 2 }));
});
