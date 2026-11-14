import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeterministicOrganizationIntentParser,
  createOpenAiCompatibleBossConversationParser,
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

test('Boss conversation parser returns a natural reply without organization actions', async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: readonly { role: string; content: string }[];
    };
    assert.equal(body.messages[0]?.role, 'system');
    assert.match(body.messages[1]?.content ?? '', /最近对话/);
    assert.match(body.messages[1]?.content ?? '', /你刚才提到要专注文档整理/);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            reply: '我建议先按紧急程度拆成三件小事，再保留一件缓冲区。需要我把它组织成项目吗？',
            actions: [],
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_chat',
    text: '请帮我分析一下今天的工作安排，并给出建议',
    expectedSequence: 0,
    conversation: Object.freeze([
      Object.freeze({ author: 'user' as const, body: '你刚才提到要专注文档整理' }),
      Object.freeze({ author: 'assistant' as const, body: '好的，我会优先整理文档。' }),
    ]),
  });
  assert.equal(result.actions.length, 0);
  assert.equal(result.relay, '我建议先按紧急程度拆成三件小事，再保留一件缓冲区。需要我把它组织成项目吗？');
  assert.doesNotMatch(result.relay ?? '', /意图已收到|已形成/);
});

test('Boss conversation parser proposes bounded actions with a natural reply', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          reply: '我会为你建立项目并安排一名员工跟进。',
          actions: [{
            type: 'open_project',
            expectedSequence: 0,
            projectId: 'project_alpha',
            originTriggerId: 'int_chat',
          }],
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_chat',
    text: '请建立项目 Alpha',
    expectedSequence: 4,
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]?.type, 'open_project');
  assert.equal(result.actions[0]?.expectedSequence, 4);
  assert.equal(result.relay, '我会为你建立项目并安排一名员工跟进。');
});

test('Boss conversation parser binds action origin to the Runtime intent id', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          reply: '我会建立项目。',
          actions: [{
            type: 'open_project',
            expectedSequence: 0,
            projectId: 'project_alpha',
            originTriggerId: 'model-supplied',
          }],
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_runtime_origin',
    text: '请建立项目 Alpha',
    expectedSequence: 0,
  });
  assert.equal(result.actions[0]?.type, 'open_project');
  assert.equal(
    (result.actions[0] as { originTriggerId?: string }).originTriggerId,
    'int_runtime_origin',
  );
});

test('Boss conversation parser rejects plain text, unknown fields, and secret-like replies', async () => {
  const withContent = (content: string) => (async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const cases = [
    { content: '直接聊天文本', error: /valid JSON/ },
    { content: JSON.stringify({ reply: 'ok', actions: [], authority: 'all' }), error: /unknown fields/i },
    { content: JSON.stringify({ reply: '使用 sk-secret', actions: [] }), error: /secret-like/ },
  ];
  for (const item of cases) {
    const parser = createOpenAiCompatibleBossConversationParser({
      baseUrl: 'http://127.0.0.1:3425',
      model: 'fixture/boss-chat',
      fetch: withContent(item.content),
    });
    await assert.rejects(
      () => parser.parse({ intentId: 'int_bad', text: 'hello', expectedSequence: 0 }),
      item.error,
    );
  }
});

test('Boss conversation parser classifies upstream failures without a fixed reply', async () => {
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: (async () => new Response('{}', { status: 502 })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => parser.parse({ intentId: 'int_bad', text: 'hello', expectedSequence: 0 }),
    /upstream|HTTP 502|unavailable/i,
  );
});
