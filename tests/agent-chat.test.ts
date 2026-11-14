import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { PrimaryConversationService } from '../src/runtime/primary-conversation.js';
import {
  createOpenAiCompatibleBossConversationParser,
  type OrganizationIntentParser,
} from '../src/runtime/organization-intent-parser.js';
import { parseOrganizationAction, type OrganizationAction } from '../src/runtime/organization-contract.js';

function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        data: [{ id: 'fixture/chat-model', display_name: 'Fixture Chat Model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/chat/completions')) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"你好，我是配置好的 Agent。"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof globalThis.fetch;
}

function bossConversationFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        data: [{ id: 'fixture/chat-model', display_name: 'Fixture Chat Model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as {
        messages: readonly { role: string; content: string }[];
      };
      const payload = JSON.parse(body.messages[1]?.content ?? '{}') as { text?: string };
      const context = payload.text ?? '';
      const action = /建立|项目|招聘|归档|恢复/.test(context);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: action
                ? '我已经把这件事整理成项目，后续会在这里同步进展。'
                : '我建议先明确目标和验收标准，再决定要不要拆项目与招聘员工。',
              actions: action ? [{
                type: 'open_project',
                expectedSequence: 0,
                projectId: 'project_boss_conversation',
                originTriggerId: 'int_boss_conversation',
              }, {
                type: 'activate_project',
                expectedSequence: 1,
                projectId: 'project_boss_conversation',
              }] : [],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof globalThis.fetch;
}

async function withApp(run: (app: ReturnType<typeof createApp>, agentId: string) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-chat-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fakeFetch(),
  });
  const agent = await taskService.createAgent({
    name: '中文助手',
    instructions: 'You are a concise assistant.',
    providerId: 'magpie',
    modelId: 'fixture/chat-model',
  });
  const agentChat = new AgentChatService(taskService);
  const app = createApp({ logger: false, taskService, agentChatService: agentChat });
  try {
    await run(app, agent.id);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('agent chat starts a configured Agent conversation and publishes a real model reply', async () => {
  await withApp(async (app, agentId) => {
    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });
    assert.equal(runtime.json().agentChatContract, '1.5.0');
    assert.equal(runtime.json().agentChatPaths, 4);

    const agents = await app.inject({ method: 'GET', url: '/v1/agent-chat/agents' });
    assert.equal(agents.statusCode, 200);
    assert.equal(agents.json().agents.length, 1);
    assert.equal(agents.json().agents[0].name, '中文助手');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId },
    });
    assert.equal(created.statusCode, 201);
    const conversationId = created.json().id as string;
    assert.match(conversationId, /^chat_[0-9a-f]{24}$/);

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '你好', idempotencyKey: 'chat-fixture-1' },
    });
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.json().userMessage.body, '你好');
    assert.match(sent.json().assistantMessage.state, /thinking|streaming|replied/);

    let conversation = await app.inject({
      method: 'GET',
      url: `/v1/agent-chat/conversations/${conversationId}`,
    });
    for (let attempt = 0; attempt < 50 && conversation.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      conversation = await app.inject({
        method: 'GET',
        url: `/v1/agent-chat/conversations/${conversationId}`,
      });
    }
    assert.equal(conversation.json().messages.length, 2);
    assert.equal(conversation.json().messages[1]?.state, 'replied');
    assert.match(conversation.json().messages[1]?.body ?? '', /配置好的 Agent/);
    assert.doesNotMatch(JSON.stringify(conversation.json()), /runtime\.sqlite|\.conchbase\/|sk-|Bearer/i);

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '你好', idempotencyKey: 'chat-fixture-1' },
    });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().userMessage.id, sent.json().userMessage.id);
    assert.equal(conversation.json().messages.length, 2);

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/agent-chat/conversations/chat_missing',
    });
    assert.equal(missing.statusCode, 404);

    const secret = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: 'sk-secret', idempotencyKey: 'chat-fixture-secret' },
    });
    assert.equal(secret.statusCode, 400);
  });
});

test('boss agent appears in Agent Chat and routes messages through Boss Mode', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-agent-chat-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fakeFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser: OrganizationIntentParser = {
    async parse(input) {
      const actions: readonly OrganizationAction[] = Object.freeze([
        parseOrganizationAction({
          type: 'open_project',
          expectedSequence: input.expectedSequence,
          projectId: 'project_boss_chat',
          originTriggerId: input.intentId,
        }),
        parseOrganizationAction({
          type: 'activate_project',
          expectedSequence: input.expectedSequence + 1,
          projectId: 'project_boss_chat',
        }),
      ]);
      return Object.freeze({ version: 1 as const, intentId: input.intentId, actions, relay: '老板已建立项目。' });
    },
  };
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(taskService, bossMode);
  const app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  try {
    const agents = await app.inject({ method: 'GET', url: '/v1/agent-chat/agents' });
    assert.equal(agents.json().agents[0].id, 'boss-agent');
    assert.equal(agents.json().agents[0].name, '老板 Agent');
    assert.equal(agents.json().agents[0].providerId, 'runtime');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId: 'boss-agent' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().agentId, 'boss-agent');
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${created.json().id}/messages`,
      payload: { text: '请建立项目并汇报', idempotencyKey: 'boss-chat-fixture-1' },
    });
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.json().assistantMessage.author, 'assistant');
    assert.equal(sent.json().assistantMessage.state, 'thinking');
    let bossView = await app.inject({
      method: 'GET',
      url: `/v1/agent-chat/conversations/${created.json().id}`,
    });
    for (let attempt = 0; attempt < 50 && bossView.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      bossView = await app.inject({
        method: 'GET',
        url: `/v1/agent-chat/conversations/${created.json().id}`,
      });
    }
    assert.equal(bossView.json().messages[1]?.body, '老板已建立项目。');
    assert.equal(bossView.json().messages[1]?.state, 'replied');
    assert.equal(bossView.json().messages[1]?.taskId, null);
    const session = await app.inject({ method: 'GET', url: '/v1/organization/session' });
    assert.equal(session.json().projects.some((project: { id: string }) => project.id === 'project_boss_chat'), true);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent chat publishes thinking, streaming, and replied states', async () => {
  await withApp(async (app, agentId) => {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId },
    });
    const conversationId = created.json().id as string;
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '请回复你好', idempotencyKey: 'chat-state-fixture-1' },
    });
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.json().assistantMessage.author, 'assistant');
    assert.match(sent.json().assistantMessage.state, /thinking|streaming|replied/);
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 50 && view.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    assert.equal(view.json().messages[1]?.state, 'replied');
    assert.equal(view.json().messages[1]?.phase, 'terminal');
    assert.match(view.json().messages[1]?.body ?? '', /配置好的 Agent/);
    assert.equal(view.json().messages[1]?.replyToId, sent.json().userMessage.id);
  });
});

test('agent chat publishes unavailable state when the model catalog fails', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-chat-unavailable-'));
  let catalogCalls = 0;
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        catalogCalls += 1;
        if (catalogCalls > 1) return new Response('{}', { status: 503 });
        return new Response(JSON.stringify({
          data: [{ id: 'fixture/chat-model', display_name: 'Fixture Chat Model' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 503 });
    }) as typeof globalThis.fetch,
  });
  const agent = await taskService.createAgent({
    name: '临时助手',
    instructions: '请简洁回答。',
    providerId: 'magpie',
    modelId: 'fixture/chat-model',
  });
  const agentChat = new AgentChatService(taskService);
  const app = createApp({ logger: false, taskService, agentChatService: agentChat });
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: agent.id },
    });
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${created.json().id}/messages`,
      payload: { text: '你好', idempotencyKey: 'unavailable-fixture-1' },
    });
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.json().assistantMessage.state, 'unavailable');
    assert.match(sent.json().assistantMessage.error ?? '', /catalog/i);
    const view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${created.json().id}` });
    assert.equal(view.json().messages.length, 2);
    assert.equal(view.json().messages[1]?.state, 'unavailable');
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boss mode invokes the accepted callback before returning its final result', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-chat-slow-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fakeFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser: OrganizationIntentParser = {
    async parse(input) {
      const actions: readonly OrganizationAction[] = Object.freeze([
        parseOrganizationAction({
          type: 'open_project', expectedSequence: input.expectedSequence,
          projectId: 'project_slow', originTriggerId: input.intentId,
        }),
        parseOrganizationAction({
          type: 'activate_project', expectedSequence: input.expectedSequence + 1,
          projectId: 'project_slow',
        }),
      ]);
      return Object.freeze({ version: 1 as const, intentId: input.intentId, actions, relay: '老板已接受。' });
    },
  };
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: true });
  try {
    let accepted = false;
    const result = await bossMode.submit({ text: '开始', idempotencyKey: 'slow-boss-fixture-1' }, () => {
      accepted = true;
    });
    assert.equal(accepted, true);
    assert.equal(result.reply, '老板已接受。');
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boss agent publishes a natural model reply for ordinary conversation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-natural-chat-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const conversation = new PrimaryConversationService();
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(taskService, bossMode);
  const app = createApp({
    logger: false,
    taskService,
    organizationStore: organization,
    bossModeService: bossMode,
    agentChatService: agentChat,
    conversationService: conversation,
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId: 'boss-agent' },
    });
    const conversationId = created.json().id as string;
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '请帮我分析一下今天的工作安排，并给出建议', idempotencyKey: 'boss-natural-1' },
    });
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.json().assistantMessage.taskId, null);
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 50 && view.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    assert.equal(view.json().messages[1]?.state, 'replied');
    assert.match(view.json().messages[1]?.body ?? '', /明确目标和验收标准/);
    assert.doesNotMatch(view.json().messages[1]?.body ?? '', /意图已收到|已形成|模型未返回内容/);
    assert.equal(organization.get().projects.length, 0);
    assert.equal(taskService.store.listTasks().length, 0);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boss agent uses an organization capability and still replies naturally', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-action-chat-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(taskService, bossMode);
  const app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: 'boss-agent' },
    });
    const conversationId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '请建立项目 Alpha 并安排后续跟进', idempotencyKey: 'boss-action-1' },
    });
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 50 && view.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    assert.match(view.json().messages[1]?.body ?? '', /整理成项目/);
    assert.equal(view.json().messages[1]?.state, 'replied');
    assert.equal(organization.get().projects.length, 1);
    assert.equal(organization.get().projects[0]?.state, 'active');
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boss agent classifies malformed conversational model output as unavailable', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-unavailable-chat-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/chat-model',
    fetch: (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '我只是一段普通文本' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch,
  });
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(taskService, bossMode);
  const app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: 'boss-agent' },
    });
    const conversationId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '你好', idempotencyKey: 'boss-unavailable-1' },
    });
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 50 && view.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    assert.equal(view.json().messages[1]?.state, 'unavailable');
    assert.doesNotMatch(view.json().messages[1]?.body ?? '', /意图已收到|已形成/);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pure boss conversation does not write organization intent state', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-pure-chat-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const conversation = new PrimaryConversationService();
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(taskService, bossMode);
  const app = createApp({
    logger: false,
    taskService,
    organizationStore: organization,
    bossModeService: bossMode,
    agentChatService: agentChat,
    conversationService: conversation,
  });
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: 'boss-agent' },
    });
    const conversationId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '你好', idempotencyKey: 'boss-pure-1' },
    });
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 50 && view.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    assert.equal(view.json().messages[1]?.state, 'replied');
    assert.equal(organization.get().events.length, 0);
    assert.equal(conversation.intentTextsView().size, 0);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a completed boss conversation survives restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-restart-'));
  const filename = path.join(directory, 'runtime.sqlite');
  let taskService = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  let bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  let agentChat = new AgentChatService(taskService, bossMode);
  let app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  let conversationId: string;
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: 'boss-agent' },
    });
    conversationId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '你好', idempotencyKey: 'boss-restart-complete' },
    });
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 50 && view.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    assert.equal(view.json().messages[1]?.state, 'replied');
  } finally {
    await app.close();
    await taskService.stop();
  }

  taskService = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  agentChat = new AgentChatService(taskService, bossMode);
  app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  try {
    const reopened = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().messages.length, 2);
    assert.equal(reopened.json().messages[1]?.state, 'replied');
    assert.match(reopened.json().messages[1]?.body ?? '', /明确目标和验收标准/);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an in-flight boss reply becomes unavailable after restart without losing its conversation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-inflight-restart-'));
  const filename = path.join(directory, 'runtime.sqlite');
  let taskService = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  let bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  let agentChat = new AgentChatService(taskService, bossMode);
  let app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  let conversationId: string;
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: 'boss-agent' },
    });
    conversationId = created.json().id as string;
    const stalledParser = createOpenAiCompatibleBossConversationParser({
      baseUrl: 'http://127.0.0.1:3425',
      model: 'fixture/chat-model',
      fetch: (async () => new Promise<Response>(() => {
        // Deliberately never resolves; this simulates a Runtime restart during an in-flight model turn.
      })) as typeof globalThis.fetch,
    });
    bossMode = new BossModeService(organization, taskService, { parser: stalledParser, waitForTasks: false });
    agentChat = new AgentChatService(taskService, bossMode);
    app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
    const body = {
      text: '你好，请回复',
      idempotencyKey: 'boss-inflight-restart',
    };
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: body,
    });
    assert.equal(sent.statusCode, 202);
    assert.equal(sent.json().assistantMessage.state, 'thinking');
  } finally {
    await app.close();
    await taskService.stop();
  }
  taskService = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  agentChat = new AgentChatService(taskService, bossMode);
  app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  try {
    const reopened = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().messages.length, 2);
    assert.equal(reopened.json().messages[1]?.state, 'unavailable');
    assert.equal(reopened.json().messages[1]?.phase, 'terminal');
    assert.match(reopened.json().messages[1]?.error ?? '', /restart/i);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a completed configured-Agent reply survives restart as replied', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-reply-restart-'));
  const filename = path.join(directory, 'runtime.sqlite');
  let taskService = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fakeFetch(),
  });
  let app = createApp({ logger: false, taskService });
  let conversationId: string;
  let agentId: string;
  try {
    const agent = await taskService.createAgent({
      name: '中文助手',
      instructions: 'You are a concise assistant.',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    agentId = agent.id;
    const agentChat = new AgentChatService(taskService);
    app = createApp({ logger: false, taskService, agentChatService: agentChat });
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId },
    });
    conversationId = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '你好', idempotencyKey: 'agent-reply-restart' },
    });
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 50 && view.json().messages[1]?.phase !== 'terminal'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    assert.equal(view.json().messages[1]?.state, 'replied');
    assert.match(view.json().messages[1]?.body ?? '', /配置好的 Agent/);
    assert.equal(agentId.length > 0, true);
  } finally {
    await app.close();
    await taskService.stop();
  }
  taskService = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fakeFetch(),
  });
  app = createApp({ logger: false, taskService, agentChatService: new AgentChatService(taskService) });
  try {
    const reopened = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().messages[1]?.state, 'replied');
    assert.match(reopened.json().messages[1]?.body ?? '', /配置好的 Agent/);
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent chat conversation pins a user-selected model override', async () => {
  await withApp(async (app, agentId) => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId, modelOverride: { providerId: 'magpie', modelId: 'fixture/chat-model' } },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().providerId, 'magpie');
    assert.equal(created.json().modelId, 'fixture/chat-model');
  });
});

test('agent chat rejects an unavailable model override', async () => {
  await withApp(async (app, agentId) => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId, modelOverride: { providerId: 'magpie', modelId: 'fixture/missing-model' } },
    });
    assert.equal(created.statusCode, 400);
    assert.match(created.json().error, /not available|不可用|模型/i);
  });
});

test('boss agent chat pins a user-selected conversation model', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-model-select-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/chat-model',
    fetch: bossConversationFetch(),
  });
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(taskService, bossMode);
  const app = createApp({ logger: false, taskService, organizationStore: organization, bossModeService: bossMode, agentChatService: agentChat });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId: 'boss-agent', modelOverride: { providerId: 'magpie', modelId: 'fixture/chat-model' } },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().modelId, 'fixture/chat-model');
  } finally {
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
