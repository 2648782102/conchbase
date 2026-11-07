import assert from 'node:assert/strict';
import test from 'node:test';
import { MagpieModelCatalog } from '../src/runtime/model-catalog.js';

test('the model catalog parses a local OpenAI-compatible model list', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const catalog = new MagpieModelCatalog({
    baseUrl: 'http://127.0.0.1:3425',
    appKey: 'magpie-conchbase',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        data: [
          { id: 'provider/model-a', display_name: 'Model A' },
          { id: 'provider/model-b' },
          { id: '' },
          null,
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(await catalog.listModels(), [
    { id: 'provider/model-a', displayName: 'Model A' },
    { id: 'provider/model-b', displayName: 'provider/model-b' },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:3425/v1/models');
  const headers = requests[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer magpie-conchbase');
});

test('the model catalog normalizes invalid responses and request failures', async () => {
  const invalid = new MagpieModelCatalog({
    baseUrl: 'http://127.0.0.1:3425',
    fetch: async () => new Response('{}', { status: 200 }),
  });
  await assert.rejects(invalid.listModels(), /Model catalog is unavailable/);

  const unavailable = new MagpieModelCatalog({
    baseUrl: 'http://127.0.0.1:3425',
    fetch: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(unavailable.listModels(), /Model catalog is unavailable/);
});
