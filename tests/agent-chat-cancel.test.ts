import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';

/**
 * A reply nobody can stop is a reply the user has to wait out.
 *
 * The Runtime could already cancel a task, but Agent Chat had no route for it
 * and the console could only *render* a cancelled state. Two shapes have to
 * work: a turn the model is working through, and a turn still queued behind an
 * earlier one — the second has no task to abort, so cancelling it must drop it
 * from the queue instead of doing nothing and letting the reply arrive anyway.
 */
function providerFixture(state: { release: (() => void) | null; entered: (() => void) | null }) {
  let completions = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    completions += 1;
    if (completions === 1) {
      state.entered?.();
      // A real provider aborts its HTTP call; the fixture has to do the same or
      // it would model a gateway that ignores cancellation.
      await new Promise<void>((resolve, reject) => {
        state.release = resolve;
        init?.signal?.addEventListener('abort', () => {
          resolve();
          reject(new Error('aborted'));
        }, { once: true });
      });
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `回复${completions}` }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-cancel-'));
  const state: { release: (() => void) | null; entered: (() => void) | null } = { release: null, entered: null };
  const entered = new Promise<void>((resolve) => { state.entered = resolve; });
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFixture(state),
  });
  const chat = new AgentChatService(taskService);
  const agent = await taskService.createAgent({
    name: '取消员', instructions: '', providerId: 'magpie', modelId: 'fixture/chat-model',
  });
  const conversation = await chat.createConversation({ agentId: agent.id });
  return {
    directory, state, entered, taskService, chat, conversation,
    async cleanup() {
      chat.close();
      state.release?.();
      await taskService.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('cancelling a running reply stops its task and settles the message', async () => {
  const f = await fixture();
  try {
    await f.chat.postMessage(f.conversation.id, { text: '第一个问题', idempotencyKey: 'c1' });
    await f.entered;

    const result = f.chat.cancelTurn(f.conversation.id);
    assert.equal(result.cancelled, true);
    assert.ok(['cancelled', 'failed'].includes(result.assistantMessage.state), result.assistantMessage.state);

    const taskId = result.assistantMessage.taskId;
    assert.ok(taskId);
    // The task must reach a terminal state rather than hanging in cancelling.
    for (let tick = 0; tick < 200; tick += 1) {
      const state = f.taskService.store.getTask(taskId!)?.state;
      if (state === 'cancelled' || state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.taskService.store.getTask(taskId!)?.state, 'cancelled');
  } finally {
    await f.cleanup();
  }
});

test('cancelling a queued reply drops it instead of letting it run later', async () => {
  const f = await fixture();
  try {
    await f.chat.postMessage(f.conversation.id, { text: '第一个问题', idempotencyKey: 'q1' });
    await f.entered;
    const queued = await f.chat.postMessage(f.conversation.id, { text: '第二个问题', idempotencyKey: 'q2' });
    assert.equal(queued.assistantMessage.state, 'pending');

    const result = f.chat.cancelTurn(f.conversation.id);
    assert.equal(result.cancelled, true);
    assert.equal(result.assistantMessage.id, queued.assistantMessage.id, 'the newest turn is the one cancelled');
    assert.equal(result.assistantMessage.state, 'cancelled');

    // Let the first turn finish; the cancelled one must not start.
    f.state.release?.();
    for (let tick = 0; tick < 300; tick += 1) {
      const messages = f.chat.view(f.conversation.id).messages;
      if (messages[1]?.state === 'replied' || messages[1]?.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const messages = f.chat.view(f.conversation.id).messages;
    assert.equal(messages[3]?.state, 'cancelled', 'the queued reply stays cancelled');
    assert.equal(messages[3]?.taskId, null, 'and never acquired a task');
  } finally {
    await f.cleanup();
  }
});

test('cancelling when nothing is running is a conflict, not a silent success', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.chat.cancelTurn(f.conversation.id), /no running reply/i);
  } finally {
    await f.cleanup();
  }
});

test('the cancel route is reachable and reports through the conversation', async () => {
  const f = await fixture();
  const app = createApp({ logger: false, taskService: f.taskService, agentChatService: f.chat });
  try {
    await f.chat.postMessage(f.conversation.id, { text: '问题', idempotencyKey: 'r1' });
    await f.entered;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${f.conversation.id}/cancel`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { cancelled: boolean; assistantMessage: { state: string } };
    assert.equal(body.cancelled, true);
    assert.ok(['cancelled', 'failed'].includes(body.assistantMessage.state));
  } finally {
    await app.close();
    await f.cleanup();
  }
});
