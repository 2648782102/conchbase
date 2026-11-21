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
        /*
         * Capability comes from the gateway's own `reasoning` flag now, not
         * from the shape of the model id. The old heuristic matched `/reason/`
         * against the id, which both invented reasoning for models that had
         * none and missed it for models that did.
         */
        { id: 'reason/model', display_name: 'Reason', context_window: 128000, reasoning: true },
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

test('the catalog carries the effort levels each model publishes', async () => {
  /*
   * This is the data the composer's effort menu is built from. Until it was
   * forwarded, every client had to assume the same three levels for every
   * model, which is how "思考强度" ended up offering values that several models
   * do not accept.
   */
  const catalog = new MagpieModelCatalog({
    baseUrl: 'http://127.0.0.1:3425',
    fetch: (async () => new Response(JSON.stringify({
      data: [
        { id: 'deepseek/flash', reasoning: true, reasoning_levels: ['none', 'low', 'high', 'max'] },
        { id: 'gpt/terra', reasoning: true, reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        // Published only in the object form; both shapes must be read.
        { id: 'gemini/hydrogen', reasoning: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }] },
        // Reasons, but offers no choice.
        { id: 'gemma/26b', reasoning: true, reasoning_levels: [] },
        // No reasoning at all: no list, and no claim.
        { id: 'plain/model' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch,
  });
  const models = await catalog.listModels();
  const levels = (id: string) => models.find((model) => model.id === id)?.reasoningLevels;

  assert.deepEqual(levels('deepseek/flash'), ['none', 'low', 'high', 'max'], 'published order is kept when known');
  assert.deepEqual(levels('gpt/terra'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(levels('gemini/hydrogen'), ['low', 'xhigh'], 'the object form is read too');
  assert.deepEqual(levels('gemma/26b'), [], 'an empty list is a fact: reasons, but no choice');
  assert.equal(levels('plain/model'), undefined, 'a model without reasoning advertises no list');
  assert.equal(models.find((model) => model.id === 'plain/model')?.supportsReasoning, false);
});
