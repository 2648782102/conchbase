import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import { createBuiltinWriteTools } from '../src/runtime/write-tools.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

function catalog(): ModelCatalogClient {
  return {
    async listModels() {
      return Object.freeze([{ id: 'fixture/model', displayName: 'Fixture' }]);
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'call_0000000000000001', type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }] } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function text(value: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: value } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function scripted(turns: readonly (() => Response)[]): typeof globalThis.fetch {
  let index = 0;
  return (async () => turns[Math.min(index++, turns.length - 1)]!()) as typeof globalThis.fetch;
}

async function waitForTask(service: TaskService, taskId: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (service.store.getTask(taskId)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`task did not reach ${state}`);
}

test('agent chat projects tool activity and can approve a write inside the conversation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-tools-'));
  const read = createBuiltinReadTools({ root: directory });
  const write = createBuiltinWriteTools({ root: directory });
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([
        () => toolCall('workspace_write', { path: 'note.txt', content: 'hello' }),
        () => text('已写入 note.txt。'),
      ]),
    },
    catalog(),
    {
      tools: {
        list: () => Object.freeze([...read.list(), ...write.list()]),
        has: (id) => read.has(id) || write.has(id),
        invoke: (id, args) => read.has(id) ? read.invoke(id, args) : write.invoke(id, args),
      },
    },
  );
  const agentChat = new AgentChatService(service);
  const app = createApp({ logger: false, taskService: service, agentChatService: agentChat });
  try {
    const agent = await service.createAgent({
      name: '文件助手', instructions: 'Write files when asked.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: agent.id },
    });
    const conversationId = created.json().id as string;
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '写一条 note.txt', idempotencyKey: 'chat-tools-1' },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    const assistantId = sent.json().assistantMessage.id as string;

    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 200 && view.json().messages[1]?.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    const waiting = view.json().messages[1];
    assert.equal(waiting.state, 'waiting_approval');
    assert.equal(waiting.phase, 'human');
    assert.ok(waiting.activity.some((entry: { kind: string }) => entry.kind === 'tool'));
    assert.ok(waiting.activity.some((entry: { kind: string }) => entry.kind === 'approval'));
    assert.equal(existsSync(path.join(directory, 'note.txt')), false);

    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/approval`,
      payload: { assistantMessageId: assistantId, decision: 'approved' },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(rejected.json().assistantMessage.taskId, sent.json().assistantMessage.taskId);

    await waitForTask(service, sent.json().assistantMessage.taskId, 'succeeded');
    const final = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    const reply = final.json().messages[1];
    assert.equal(reply.state, 'replied');
    assert.equal(reply.phase, 'terminal');
    assert.equal(reply.body, '已写入 note.txt。');
    assert.ok(reply.activity.some((entry: { kind: string; state: string }) =>
      entry.kind === 'tool' && entry.state === 'succeeded'));
    assert.equal(readFileSync(path.join(directory, 'note.txt'), 'utf8'), 'hello');

    const again = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/approval`,
      payload: { assistantMessageId: assistantId, decision: 'approved' },
    });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
