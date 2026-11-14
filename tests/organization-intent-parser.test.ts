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

test('Boss conversation parser streams answer deltas and parses final strict JSON', async () => {
  const progress: number[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    assert.equal(body.stream, true);
    const frame = (text: string) => `data: ${JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}\n\n`;
    const final = JSON.stringify({ reply: '你好，我在。', actions: [] });
    return new Response(
      `${frame(final.slice(0, 8))}${frame(final.slice(8))}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_stream',
    text: '你好',
    expectedSequence: 0,
    onProgress: (value) => progress.push(value.percent),
  });
  assert.equal(result.relay, '你好，我在。');
  assert.equal(result.actions.length, 0);
  assert.ok(progress.some((value) => value > 0 && value < 100));
  assert.equal(progress.at(-1), 100);
});

test('Boss conversation parser exposes partial natural reply text while streaming', async () => {
  const partials: string[] = [];
  const fetchImpl = (async () => {
    const json = JSON.stringify({ reply: '我正在整理今天的安排。', actions: [] });
    const frame = (text: string) => `data: ${JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}\n\n`;
    return new Response(
      `${frame(json.slice(0, 20))}${frame(json.slice(20))}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  await parser.parse({
    intentId: 'int_partial',
    text: '帮我安排今天',
    expectedSequence: 0,
    onProgress: (progress) => {
      if (progress.previousText) partials.push(progress.previousText);
    },
  });
  assert.ok(partials.some((text) => text.includes('我正在整理')));
});

test('Boss conversation parser normalizes false upstream identity and unsupported capability claims', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          reply: '我是腾讯混元 Hy。我可以帮你查网页和读取 MacBook 文件。',
          actions: [],
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
    intentId: 'int_identity',
    text: '你是谁，能查网页和本机文件吗',
    expectedSequence: 0,
  });
  assert.match(result.relay ?? '', /老板 Agent/);
  assert.doesNotMatch(result.relay ?? '', /腾讯混元|Hy\b/);
  assert.match(result.relay ?? '', /没有|暂不|不能/);
  assert.match(result.relay ?? '', /网页|本机|文件/);
});

test('Boss conversation request includes readable organization facts and capability boundaries', async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: readonly { role: string; content: string }[];
    };
    const payload = JSON.parse(body.messages[1]?.content ?? '{}') as {
      organization?: {
        projects?: readonly { purpose?: string; state?: string }[];
        workers?: readonly { displayName?: string; instructions?: string; state?: string }[];
        capabilities?: readonly { id?: string; available?: boolean }[];
      };
    };
    assert.equal(payload.organization?.projects?.[0]?.purpose, '整理海螺的发布文档');
    assert.equal(payload.organization?.workers?.[0]?.displayName, '校验员');
    assert.equal(payload.organization?.workers?.[0]?.instructions, '检查发布包');
    assert.equal(payload.organization?.workers?.[0]?.state, 'blocked');
    assert.equal(payload.organization?.capabilities?.some((item) =>
      item.id === 'external-web' && item.available === false), true);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ reply: '我先看现有组织事实。', actions: [] }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_facts',
    text: '项目和员工是做什么的',
    expectedSequence: 0,
    organizationFacts: {
      bossSessionId: 'boss_fixture',
      projects: [{
        id: 'project_alpha',
        state: 'active',
        purpose: '整理海螺的发布文档',
        originIntent: '帮我整理发布文档',
      }],
      workers: [{
        id: 'wrk_validator',
        projectId: 'project_alpha',
        displayName: '校验员',
        state: 'blocked',
        instructions: '检查发布包',
        scope: ['project:alpha'],
        capabilities: ['cap_read_context'],
        model: { providerId: 'magpie', modelId: 'fixture/chat-model' },
      }],
      delegations: [],
      reports: [],
      attention: [],
      capabilities: [
        { id: 'organization', available: true, description: '项目、员工、汇报与归档' },
        { id: 'agent-chat', available: true, description: '当前对话模型' },
        { id: 'external-web', available: false, description: '网页搜索与联网读取' },
        { id: 'local-files', available: false, description: '本机文件与设备查询' },
      ],
    },
  });
  assert.equal(result.relay, '我先看现有组织事实。');
});

test('Boss conversation parser uses the selected model reference for the provider request', async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model?: string };
    assert.equal(body.model, 'fixture/selected-model');
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ reply: '好的。', actions: [] }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/default-model',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_selected',
    text: '你好',
    expectedSequence: 0,
    modelReference: { providerId: 'magpie', modelId: 'fixture/selected-model' },
  });
  assert.equal(result.relay, '好的。');
});

test('Boss conversation parser drops extra display-only action fields instead of failing the turn', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          reply: '我会建立这个项目。',
          actions: [{
            type: 'open_project',
            expectedSequence: 0,
            projectId: 'project_website',
            name: 'website-redesign',
            purpose: '重做官网',
            metadata: { owner: 'me' },
          }, {
            type: 'activate_project',
            expectedSequence: 1,
            projectId: 'project_website',
            note: '启动',
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
    intentId: 'int_extra_fields',
    text: '建立项目 website-redesign',
    expectedSequence: 0,
  });
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions[0]?.type, 'open_project');
  assert.equal(result.actions[1]?.type, 'activate_project');
  assert.equal(result.relay, '我会建立这个项目。');
});

test('Boss conversation parser still rejects actions missing required fields', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          reply: '建立项目。',
          actions: [{ type: 'open_project', name: 'no-id' }],
        }),
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => parser.parse({ intentId: 'int_missing', text: '建立项目', expectedSequence: 0 }),
    /projectId|expectedSequence|missing/i,
  );
});

test('Boss conversation parser accepts strict JSON wrapped in a Markdown code fence', async () => {
  const payload = JSON.stringify({
    reply: '我在。',
    actions: [],
  });
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: `\`\`\`json\n${payload}\n\`\`\`` } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/boss-chat',
    fetch: fetchImpl,
  });
  const result = await parser.parse({
    intentId: 'int_fenced',
    text: '你好',
    expectedSequence: 0,
  });
  assert.equal(result.relay, '我在。');
});
