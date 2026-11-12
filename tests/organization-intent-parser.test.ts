import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeterministicOrganizationIntentParser,
  createOpenAiCompatibleOrganizationIntentParser,
} from '../src/runtime/organization-intent-parser.js';

test('deterministic parser rejects secret-like intent text', async () => {
  const parser = createDeterministicOrganizationIntentParser();
  await assert.rejects(
    () => parser.parse({
      intentId: 'int_fixture',
      text: 'start project alpha with sk-secret',
      expectedSequence: 0,
    }),
    /secret-like/,
  );
});

test('OpenAI-compatible parser validates structured JSON and reparses accepted actions', async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: readonly { role: string; content: string }[];
    };
    assert.equal(body.messages[0]?.role, 'system');
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            actions: [{
              type: 'open_project',
              expectedSequence: 0,
              projectId: 'project_alpha',
              originTriggerId: 'int_model',
            }],
            relay: 'Model proposed one project.',
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleOrganizationIntentParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-parser',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_model',
    text: 'start project alpha',
    expectedSequence: 0,
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]?.type, 'open_project');
  assert.equal(result.relay, 'Model proposed one project.');
});

test('OpenAI-compatible parser rejects out-of-schema actions and secret-like relay', async () => {
  const withContent = (content: string) => (async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const badAction = createOpenAiCompatibleOrganizationIntentParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-parser',
    fetch: withContent(JSON.stringify({
      actions: [{ type: 'grant_all', expectedSequence: 0, projectId: 'project_alpha' }],
      relay: null,
    })),
  });
  await assert.rejects(
    () => badAction.parse({ intentId: 'int_bad', text: 'attack', expectedSequence: 0 }),
    /Action type/,
  );
  const secretRelay = createOpenAiCompatibleOrganizationIntentParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-parser',
    fetch: withContent(JSON.stringify({ actions: [], relay: 'use sk-secret' })),
  });
  await assert.rejects(
    () => secretRelay.parse({ intentId: 'int_bad2', text: 'attack', expectedSequence: 0 }),
    /secret-like/,
  );
});
