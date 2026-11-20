import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createOpenAiCompatibleBossConversationParser } from '../src/runtime/organization-intent-parser.js';

/**
 * A Runtime notice is not an Assistant turn.
 *
 * The notice was authored as `assistant` with a null taskId. Two consequences
 * made that wrong, and both were observed against a live Runtime:
 *
 * 1. the transcript said the model had spoken something it never said;
 * 2. the context builder kept any non-empty body, so the notice was replayed to
 *    the model as `Assistant: <notice>` on the next turn — the Runtime's own
 *    operational messages became part of the model's self-description.
 *
 * The second is the one that matters: it accumulates with every converged
 * project, so the model's view of itself drifts.
 */

function bossReply(): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ reply: '好的。', actions: [] }) }, finish_reason: 'stop' }],
  });
}

interface Captured {
  readonly bodies: string[];
}

/** Boss submission is fire-and-forget, so the provider call lands later. */
async function waitForCalls(captured: Captured, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && captured.bodies.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function capturingFetch(captured: Captured): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    captured.bodies.push(typeof init?.body === 'string' ? init.body : '');
    return new Response(bossReply(), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

async function withBossChat(
  run: (context: {
    readonly chat: AgentChatService;
    readonly conversationId: string;
    readonly captured: Captured;
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-notice-'));
  const captured: Captured = { bodies: [] };
  const providerFetch = capturingFetch(captured);
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425', model: 'fixture/chat-model', fetch: providerFetch,
  });
  const bossMode = new BossModeService(new InMemoryOrganizationStore(), taskService, {
    parser,
    waitForTasks: false,
  });
  const chat = new AgentChatService(taskService, bossMode);
  try {
    const conversation = await chat.createConversation({ agentId: 'boss-agent' });
    await run({ chat, conversationId: conversation.id, captured });
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

const NOTICE = 'SENTINEL_NOTICE_TEXT_project_archived';

test('a Runtime notice is authored as runtime, not assistant', async () => {
  await withBossChat(async ({ chat, conversationId }) => {
    const notice = chat.announceBossNotice({ conversationId, body: NOTICE, idempotencyKey: 'notice-1' });
    assert.equal(notice.author, 'runtime');
    assert.equal(notice.taskId, null);
    assert.equal(notice.body, NOTICE);
  });
});

test('a Runtime notice is never replayed to the model as an Assistant turn', async () => {
  await withBossChat(async ({ chat, conversationId, captured }) => {
    await chat.postMessage(conversationId, { text: '第一条', idempotencyKey: 'm1' });
    await waitForCalls(captured, 1);
    chat.announceBossNotice({ conversationId, body: NOTICE, idempotencyKey: 'notice-1' });
    await chat.postMessage(conversationId, { text: '第二条', idempotencyKey: 'm2' });
    await waitForCalls(captured, 2);

    assert.ok(captured.bodies.length >= 2, 'both turns reached the provider');
    for (const body of captured.bodies) {
      assert.equal(
        body.includes(NOTICE),
        false,
        'a Runtime notice must not enter the model transcript',
      );
    }
  });
});

test('the user and assistant turns still reach the model', async () => {
  await withBossChat(async ({ chat, conversationId, captured }) => {
    await chat.postMessage(conversationId, { text: '第一条', idempotencyKey: 'm1' });
    await waitForCalls(captured, 1);
    await chat.postMessage(conversationId, { text: '第二条', idempotencyKey: 'm2' });
    await waitForCalls(captured, 2);

    const last = captured.bodies.at(-1) ?? '';
    assert.match(last, /第一条/, 'the earlier user turn is still context');
    assert.match(last, /第二条/, 'the current user turn is still present');
    assert.match(last, /好的。/, 'the earlier assistant reply is still context');
  });
});

/**
 * The window is trimmed forward to a question, so a replayed transcript never
 * opens on an answer whose question was cut off.
 *
 * A plain `slice(-8)` looks safe because a healthy conversation alternates by
 * two. It stops being safe as soon as the newest exchange has no reply yet —
 * the state a chat is in most of the time — because the missing assistant turn
 * shifts the parity and the window starts one message late.
 */
test('the replayed prompt opens on a question, not on an orphaned answer', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-window-'));
  const prompts: string[] = [];
  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: readonly { role: string; content: string }[] };
    const userTurn = (body.messages ?? []).filter((message) => message.role === 'user').map((message) => message.content).join('\n');
    if (userTurn.length > 0) prompts.push(userTurn);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '好的。' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  try {
    const agent = await taskService.createAgent({
      name: '窗口',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    const chat = new AgentChatService(taskService);
    const conversation = await chat.createConversation({ agentId: agent.id });

    // Five complete exchanges, then a sixth question whose reply is still
    // outstanding when the window is taken.
    for (let index = 1; index <= 6; index += 1) {
      await chat.postMessage(conversation.id, { text: `Q${index}`, idempotencyKey: `q${index}` });
      for (let attempt = 0; attempt < 200 && prompts.length < index; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const last = prompts.at(-1) ?? '';
    const turns = last.split('\n').filter((line) => /^(User|Assistant): /.test(line));
    assert.ok(turns.length > 0, `no replayed turns found in:\n${last}`);
    assert.equal(
      turns[0]!.startsWith('User: '),
      true,
      `the transcript must open on a question, got:\n${turns.join('\n')}`,
    );
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

