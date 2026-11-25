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
import type { OrganizationIntentParser } from '../src/runtime/organization-intent-parser.js';
import { parseOrganizationAction } from '../src/runtime/organization-contract.js';

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

test('terminal worker reports become bounded boss notices without changing assistant turns', async () => {
  await withBossChat(async ({ chat, conversationId }) => {
    const before = chat.view(conversationId);
    const initialCount = before.messages.length;
    const reportId = 'rpt_async_worker_done';
    const workerId = 'wrk_async_worker';
    const body = [
      `员工 ${workerId} 已完成，reportId ${reportId}。`,
      '摘要：完成了一项后台工作。',
    ].join('\n');

    chat.announceBossNotice({
      conversationId,
      body,
      idempotencyKey: `worker-report:${reportId}:ready`,
    });
    chat.announceBossNotice({
      conversationId,
      body,
      idempotencyKey: `worker-report:${reportId}:ready`,
    });

    const after = chat.view(conversationId);
    const notices = after.messages.filter((message) => message.author === 'runtime');
    assert.equal(after.messages.length, initialCount + 1, 'duplicate report notice must be ignored');
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.body ?? '', /reportId rpt_async_worker_done/);
    assert.equal(notices[0]?.taskId ?? null, null);
  });
});

test('the orchestrator callback reports terminal worker outcomes', async () => {
  const outcomes: string[] = [];
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-outcome-cb-'));
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fetchImpl,
  });
  const parser: OrganizationIntentParser = {
    async parse(input) {
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze([
          parseOrganizationAction({
            type: 'open_project', expectedSequence: input.expectedSequence,
            projectId: 'project_outcome_cb', originTriggerId: input.intentId,
          }),
          parseOrganizationAction({
            type: 'activate_project', expectedSequence: input.expectedSequence + 1,
            projectId: 'project_outcome_cb',
          }),
          parseOrganizationAction({
            type: 'create_agent', expectedSequence: input.expectedSequence + 2,
            projectId: 'project_outcome_cb', workerId: 'wrk_outcome_cb',
            delegationId: 'del_outcome_cb', agentRevisionId: 'agr_placeholder',
            displayName: 'outcome worker', instructionsDigest: 'sha256_instructions',
            scope: ['project:outcome'], capabilities: ['cap_read_context'],
            model: { providerId: 'magpie', modelId: 'fixture/chat-model' },
            maxDelegationDepth: 0, ttlEvents: 50,
          }),
        ]),
        relay: 'Boss accepted the work.',
      });
    },
  };
  const bossMode = new BossModeService(new InMemoryOrganizationStore(), taskService, {
    parser, waitForTasks: true, settleBeforeWorkers: true,
    onWorkerOutcome: (outcome) => outcomes.push(`${outcome.workerId}:${outcome.taskState}`),
  });
  try {
    const result = await bossMode.submit({ text: '开始', idempotencyKey: 'outcome-cb-1' });
    assert.equal(result.executions.filter((item) => item.status === 'created-agent').length, 1);
    const taskStates = () => taskService.store.listTasks().map((task) => task.state);
    assert.deepEqual(taskStates(), ['running'], `worker must be started after submit, got ${taskStates()}`);
    for (let attempt = 0; attempt < 1000 && outcomes.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(outcomes, ['wrk_outcome_cb:succeeded']);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
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

    /*
     * Six exchanges, then a seventh. Turns are serialized: each one starts only
     * after the previous reply lands, so the wait has to be per turn rather than
     * "until N prompts exist".
     */
    for (let index = 1; index <= 6; index += 1) {
      const before = prompts.length;
      await chat.postMessage(conversation.id, { text: `Q${index}`, idempotencyKey: `q${index}` });
      for (let attempt = 0; attempt < 200 && prompts.length === before; attempt += 1) {
        chat.view(conversation.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const beforeSeventh = prompts.length;
    await chat.postMessage(conversation.id, { text: 'Q7', idempotencyKey: 'q7' });
    for (let attempt = 0; attempt < 200 && prompts.length === beforeSeventh; attempt += 1) {
      chat.view(conversation.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
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

