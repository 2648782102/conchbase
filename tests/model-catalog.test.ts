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

  const models = await catalog.listModels();
  assert.deepEqual(models.map((m) => ({ id: m.id, displayName: m.displayName })), [
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

test('known capability fields are surfaced and unknown ones are omitted', async () => {
  const { MagpieModelCatalog } = await import('../src/runtime/model-catalog.js');
  const catalog = new MagpieModelCatalog({
    baseUrl: 'http://127.0.0.1:3425',
    fetch: (async () => new Response(JSON.stringify({
      data: [
        { id: 'big/model', display_name: 'Big', context_length: 200000, modalities: { input: ['text'] } },
        { id: 'tiny/model', display_name: 'Tiny' },
        { id: 'reason/model', display_name: 'Reason', context_window: 128000 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch,
  });
  const models = await catalog.listModels();
  const big = models.find((m) => m.id === 'big/model');
  assert.equal(big?.contextTokens, 200000);
  assert.equal(big?.supportsStreaming, true);
  assert.equal(big?.supportsTools, true);
  assert.equal(big?.suitableForBoss, true);
  const tiny = models.find((m) => m.id === 'tiny/model');
  assert.equal(tiny?.contextTokens, undefined, 'absent context is omitted, not zero');
  assert.equal(tiny?.suitableForBoss, false);
  const reason = models.find((m) => m.id === 'reason/model');
  assert.equal(reason?.supportsReasoning, true);
});
