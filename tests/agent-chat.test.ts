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

async function withApp(run: (app: ReturnType<typeof createApp>, agentId: string) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-chat-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fakeFetch(),
  });
  const agent = await taskService.createAgent({
    name: 'Chat Fixture',
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
    assert.equal(sent.json().assistantMessage.state, 'pending');

    let conversation = await app.inject({
      method: 'GET',
      url: `/v1/agent-chat/conversations/${conversationId}`,
    });
    for (let attempt = 0; attempt < 50 && conversation.json().messages[1]?.state === 'pending'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      conversation = await app.inject({
        method: 'GET',
        url: `/v1/agent-chat/conversations/${conversationId}`,
      });
    }
    assert.equal(conversation.json().messages.length, 2);
    assert.equal(conversation.json().messages[1]?.state, 'succeeded');
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
