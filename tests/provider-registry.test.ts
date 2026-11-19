import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultProviderId,
  isSupportedProvider,
  listProviders,
  unsupportedProviderMessage,
} from '../src/runtime/provider-registry.js';

test('there is exactly one default provider and it is supported', () => {
  const providers = listProviders();
  assert.equal(providers.filter((p) => p.isDefault).length, 1);
  assert.equal(isSupportedProvider(defaultProviderId()), true);
});

test('unknown providers are rejected with the supported list', () => {
  assert.equal(isSupportedProvider('nonexistent'), false);
  const message = unsupportedProviderMessage('nonexistent');
  assert.match(message, /not available/);
  assert.match(message, /magpie/);
});

test('provider ids are unique', () => {
  const ids = listProviders().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
