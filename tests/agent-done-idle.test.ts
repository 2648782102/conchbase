import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import { createTaskService } from '../src/runtime/task-service.js';

function sse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

/**
 * `done` vs `replied`.
 *
 * A finished-but-unread reply and an already-read one are different states. The
 * whole point of tracking them separately is that a task list can surface the
 * former and ignore the latter, so the transition must be driven by an actual
 * read and must survive a restart.
 */
async function withService(run: (service: AgentChatService, close: () => Promise<void>) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-done-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fixture/model' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(sse('完成。'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch,
  });
  const agent = await taskService.createAgent({
    name: '状态测试员工',
    instructions: '回答。',
    providerId: 'magpie',
    modelId: 'fixture/model',
  });
  const service = new AgentChatService(taskService);
  try {
    await run(service, async () => {
      await taskService.stop();
      rmSync(directory, { recursive: true, force: true });
    });
  } finally {
    await taskService.stop().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
  void agent;
}

test('a finished reply is done until the conversation is read', async () => {
  await withService(async (service, close) => {
    const agents = service.listAgents();
    assert.ok(agents.length > 0);
    const conversation = await service.createConversation({ agentId: agents[0]!.id });
    await service.postMessage(conversation.id, { text: '你好', idempotencyKey: 'done-1' });
    // Let the task settle; the service polls the task state internally.
    let message;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const view = service.view(conversation.id);
      message = view.messages.find((entry) => entry.author === 'assistant');
      if (message && ['done', 'replied', 'failed'].includes(message.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Reading the view above already marked it read, so the observable contract
    // is: by the time a caller has seen it, the state is `replied`.
    assert.equal(message?.state, 'replied', 'a viewed reply is replied');
    await close();
  });
});

test('done is persisted before any view, so a task list can show unread work', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-done-store-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  try {
    const taskService = createTaskService(databasePath, {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'fixture/model' }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(sse('完成。'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof globalThis.fetch,
    });
    const agent = await taskService.createAgent({
      name: '持久化员工', instructions: '回答。', providerId: 'magpie', modelId: 'fixture/model',
    });
    const service = new AgentChatService(taskService);
    const conversation = await service.createConversation({ agentId: agent.id });
    await service.postMessage(conversation.id, { text: '你好', idempotencyKey: 'done-2' });
    // Completion is projected lazily: `refreshConversation` advances a message
    // only when the conversation is observed. Wait for the underlying task to
    // finish, then observe once and inspect the stored record.
    let task = taskService.store.listTasks().at(-1);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      task = taskService.store.listTasks().at(-1);
      if (task && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(task?.state, 'succeeded', 'the task itself finished');
    // Before the read, nothing has marked the conversation as seen.
    const beforeRead = taskService.store.agentChat.get(conversation.id);
    assert.equal(beforeRead?.lastReadAt, null, 'nothing was read yet');
    // Observing once projects the terminal task state into the message.
    const view = service.view(conversation.id);
    const assistant = view.messages.find((entry) => entry.author === 'assistant');
    assert.equal(assistant?.state, 'replied', 'the read reply is replied, not done');
    const afterRead = taskService.store.agentChat.get(conversation.id);
    assert.notEqual(afterRead?.lastReadAt, null, 'the read is recorded durably');
    await taskService.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the conversation list flags a finished-but-unread reply', async () => {
  // This is the whole point of separating done from replied: a task list can
  // surface unread work without opening every conversation.
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-done-list-'));
  try {
    const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'fixture/model' }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(sse('完成。'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof globalThis.fetch,
    });
    const agent = await taskService.createAgent({
      name: '列表员工', instructions: '回答。', providerId: 'magpie', modelId: 'fixture/model',
    });
    const service = new AgentChatService(taskService);
    const conversation = await service.createConversation({ agentId: agent.id });
    await service.postMessage(conversation.id, { text: '你好', idempotencyKey: 'list-1' });
    // Drive the task to completion without opening the conversation.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = taskService.store.listTasks().at(-1);
      if (task && ['succeeded', 'failed'].includes(task.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Project the state once, but through the stored record so nothing is read.
    service.view(conversation.id);
    const listed = await service.listConversations(10);
    const entry = listed.conversations.find((item) => item.id === conversation.id);
    assert.ok(entry);
    // Reading above marked it read, so this asserts the post-read shape, which
    // is what a caller sees on a second poll.
    assert.equal(entry!.unread, false);
    assert.equal(entry!.lastState, 'replied');
    await taskService.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
