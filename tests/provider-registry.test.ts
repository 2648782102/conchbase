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

test('a second OpenAI-compatible provider is registered and is not the default', () => {
  const providers = listProviders();
  const second = providers.find((p) => p.id === 'openai-compatible');
  assert.ok(second, 'openai-compatible provider must be registered');
  assert.equal(second?.isDefault, false);
  assert.equal(defaultProviderId(), 'magpie');
});

test('the loopback rule accepts local endpoints and rejects remote ones', async () => {
  const { isLoopbackBaseUrl } = await import('../src/runtime/provider-registry.js');
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:8080'), true);
  assert.equal(isLoopbackBaseUrl('http://localhost:8080'), true);
  assert.equal(isLoopbackBaseUrl('http://[::1]:8080'), true);
  assert.equal(isLoopbackBaseUrl('https://api.example.com'), false);
  assert.equal(isLoopbackBaseUrl('not a url'), false);
});
