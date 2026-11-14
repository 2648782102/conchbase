import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';

function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'fixture/first-model', display_name: 'First Model' },
          { id: 'workbuddy/blind-model-h', display_name: 'Blind H' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/chat/completions')) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"好的"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
}

async function withApp(run: (app: ReturnType<typeof createApp>, service: ReturnType<typeof createTaskService>, agentId: string) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-history-'));
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'workbuddy/blind-model-h',
    fetch: fakeFetch(),
  });
  const agent = await service.createAgent({
    name: '历史测试员',
    instructions: 'Be brief.',
    providerId: 'magpie',
    modelId: 'fixture/first-model',
  });
  const chat = new AgentChatService(service);
  const app = createApp({ logger: false, taskService: service, agentChatService: chat });
  try {
    await run(app, service, agent.id);
  } finally {
    await app.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('agent chat lists recent conversations and a default chat model', async () => {
  await withApp(async (app, _service, agentId) => {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId },
    });
    const conversationId = created.json().id as string;
    const list = await app.inject({ method: 'GET', url: '/v1/agent-chat/conversations' });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.version, '1.6.0');
    assert.ok(body.conversations.some((entry: { id: string }) => entry.id === conversationId));
    assert.equal(body.defaultModelId, 'workbuddy/blind-model-h');
    assert.doesNotMatch(JSON.stringify(body), /runtime\.sqlite|sk-/);
  });
});

test('agent chat conversation pins reasoning effort and exposes it in the list', async () => {
  await withApp(async (app, service, agentId) => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId, reasoningEffort: 'high' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().reasoningEffort, 'high');
    const list = await app.inject({ method: 'GET', url: '/v1/agent-chat/conversations' });
    const entry = list.json().conversations.find((item: { id: string }) => item.id === created.json().id);
    assert.equal(entry.reasoningEffort, 'high');
    assert.ok(service.store);
  });
});

test('agent chat rejects an unsupported reasoning effort', async () => {
  await withApp(async (app, _service, agentId) => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-chat/conversations',
      payload: { agentId, reasoningEffort: 'ultra' },
    });
    assert.equal(created.statusCode, 400);
  });
});

test('recent conversations survive a service restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-restart-'));
  const filename = path.join(directory, 'runtime.sqlite');
  let service = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'workbuddy/blind-model-h',
    fetch: fakeFetch(),
  });
  const agent = await service.createAgent({
    name: '重启历史员',
    instructions: 'Be brief.',
    providerId: 'magpie',
    modelId: 'fixture/first-model',
  });
  const chat = new AgentChatService(service);
  const app = createApp({ logger: false, taskService: service, agentChatService: chat });
  let conversationId: string;
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: agent.id, reasoningEffort: 'low' },
    });
    conversationId = created.json().id as string;
  } finally {
    await app.close();
    await service.stop();
  }
  service = createTaskService(filename, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'workbuddy/blind-model-h',
    fetch: fakeFetch(),
  });
  const reopened = createApp({ logger: false, taskService: service, agentChatService: new AgentChatService(service) });
  try {
    const list = await reopened.inject({ method: 'GET', url: '/v1/agent-chat/conversations' });
    const entry = list.json().conversations.find((item: { id: string }) => item.id === conversationId);
    assert.ok(entry);
    assert.equal(entry.reasoningEffort, 'low');
  } finally {
    await reopened.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
