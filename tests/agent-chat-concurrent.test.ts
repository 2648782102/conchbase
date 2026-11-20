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
import { createOpenAiCompatibleBossConversationParser } from '../src/runtime/organization-intent-parser.js';

function replyPayload(): string {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          reply: '收到。',
          actions: [],
        }),
      },
      finish_reason: 'stop',
    }],
  });
}

/** A provider that holds the first completion open until `release()` is called. */
function gatedFetch(gate: { release: (() => void) | null; entered: Promise<void> }) {
  let enteredResolve: (() => void) | null = null;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  gate.entered = entered;
  let completions = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model', display_name: 'Fixture' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/chat/completions')) {
      completions += 1;
      if (completions === 1) {
        enteredResolve?.();
        await new Promise<void>((resolve) => { gate.release = resolve; });
      }
      const body = JSON.parse(String(init?.body)) as { messages: readonly { role: string; content: string }[] };
      assert.ok(Array.isArray(body.messages), 'provider receives well-formed messages');
      return new Response(replyPayload(), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof globalThis.fetch;
}

test('a second message is accepted while the first boss reply is still in flight', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-concurrent-'));
  const control: { release: (() => void) | null; entered: Promise<void> } = { release: null, entered: Promise.resolve() };
  const providerFetch = gatedFetch(control);
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const organization = new InMemoryOrganizationStore();
  const parser = createOpenAiCompatibleBossConversationParser({
    baseUrl: 'http://127.0.0.1:3425', model: 'fixture/chat-model', fetch: providerFetch,
  });
  const bossMode = new BossModeService(organization, taskService, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(taskService, bossMode);
  const app = createApp({
    logger: false, taskService, organizationStore: organization, bossModeService: bossMode,
    agentChatService: agentChat,
  });
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: 'boss-agent' } });
    const conversationId = created.json().id as string;
    const url = `/v1/agent-chat/conversations/${conversationId}/messages`;

    const first = await app.inject({ method: 'POST', url, payload: { text: '第一条', idempotencyKey: 'first' } });
    assert.equal(first.statusCode, 202);
    await control.entered; // first completion is now blocked, assistant body still empty

    const second = await app.inject({ method: 'POST', url, payload: { text: '第二条', idempotencyKey: 'second' } });
    assert.equal(second.statusCode, 202, 'the second message must be accepted, not rejected');
    const secondAssistant = second.json().assistantMessage as { state?: string; error?: string };
    assert.notEqual(secondAssistant.state, 'failed', `second assistant failed: ${secondAssistant.error}`);

    control.release?.();
    let view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    for (let attempt = 0; attempt < 100 && view.json().messages.some((m: { phase: string }) => m.phase !== 'terminal'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = await app.inject({ method: 'GET', url: `/v1/agent-chat/conversations/${conversationId}` });
    }
    const messages = view.json().messages as { state: string; body: string }[];
    assert.equal(messages.filter((message) => message.state === 'replied').length, 2,
      'both messages eventually receive a reply');
  } finally {
    control.release?.();
    await app.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The second reply is written *after* the first, so it can see it.
 *
 * Two tasks started together each build their prompt from the transcript at
 * creation, so neither sees the other's answer. That is not a concurrency
 * detail a reader can reason about: two replies land side by side and read as
 * one exchange, while the second one was written as if the first question had
 * never been answered. Queueing the turn makes the later prompt the transcript
 * an ordinary conversation would have had.
 */
test('a queued turn is written after the reply it follows, and sees it', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-queue-'));
  const prompts: string[] = [];
  const gate: { release: (() => void) | null } = { release: null };
  let completions = 0;

  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model', display_name: 'Fixture' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    completions += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: readonly { role: string; content: string }[];
    };
    const userTurn = (body.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
    prompts.push(userTurn);
    if (completions === 1) {
      await new Promise<void>((resolve) => { gate.release = resolve; });
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `回复${completions}` }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const chat = new AgentChatService(taskService);
  try {
    const agent = await taskService.createAgent({
      name: '串行',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    const conversation = await chat.createConversation({ agentId: agent.id });

    await chat.postMessage(conversation.id, { text: '第一个问题', idempotencyKey: 'q1' });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const second = await chat.postMessage(conversation.id, { text: '第二个问题', idempotencyKey: 'q2' });
    assert.equal(second.assistantMessage.taskId, null, 'a queued turn has no task yet');
    assert.equal(second.assistantMessage.state, 'pending', 'a queued turn reports that it is waiting');
    assert.equal(prompts.length, 1, 'the queued turn must not reach the model while the first is running');

    gate.release?.();
    for (let attempt = 0; attempt < 150 && prompts.length < 2; attempt += 1) {
      chat.view(conversation.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(prompts.length, 2, 'the queued turn starts once the first reply lands');
    assert.match(
      prompts[1] ?? '',
      /回复1/,
      'the queued turn must be written with the earlier reply in view',
    );
    /*
     * The queued question is already a turn in the transcript, so it must not
     * also be appended as the trailing message. Doing both put the same
     * question in twice and the model read it as a repeat.
     */
    assert.equal(
      (prompts[1] ?? '').split('第二个问题').length - 1,
      1,
      'the queued question must appear once, not twice',
    );
  } finally {
    gate.release?.();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The queue is in memory, so a restart cannot resume it.
 *
 * A queued turn has no task, so the ordinary interruption path has nothing to
 * mark. The store's recovery sweep covers it: every non-terminal assistant
 * message becomes `failed` with a message saying the Runtime restarted. That is
 * the honest outcome — the turn was accepted and never answered — and it is
 * better than a `pending` message nothing will ever advance.
 */
test('a queued turn is failed, not left pending, when the Runtime restarts', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-queue-restart-'));
  const gate: { release: (() => void) | null } = { release: null };
  let completions = 0;

  const providerFetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    completions += 1;
    if (completions === 1) await new Promise<void>((resolve) => { gate.release = resolve; });
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  try {
    const agent = await taskService.createAgent({
      name: '重启',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    const chat = new AgentChatService(taskService);
    const conversation = await chat.createConversation({ agentId: agent.id });

    await chat.postMessage(conversation.id, { text: '第一个问题', idempotencyKey: 'q1' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const queued = await chat.postMessage(conversation.id, { text: '第二个问题', idempotencyKey: 'q2' });
    assert.equal(queued.assistantMessage.state, 'pending');

    // A new instance discards the in-memory queue, exactly as a restart would.
    const recovered = new AgentChatService(taskService).view(conversation.id);
    const queuedAfterRestart = recovered.messages.find((message) => message.id === queued.assistantMessage.id);
    assert.equal(queuedAfterRestart?.state, 'failed', 'a stranded queued turn must not stay pending');
    assert.match(queuedAfterRestart?.error ?? '', /重启/, 'the failure explains that the Runtime restarted');
  } finally {
    gate.release?.();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A queued question is recorded on acceptance, so it is already in the record
 * when an earlier turn is promoted. The prompt must stop at the turn being
 * started: a reply cannot answer a question the reader has not had answered
 * yet, and a model shown the later question will answer both at once.
 */
test('a later question does not leak into an earlier prompt', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-no-leak-'));
  const prompts: string[] = [];
  const gate: { release: (() => void) | null } = { release: null };
  let completions = 0;

  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    completions += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: readonly { role: string; content: string }[];
    };
    prompts.push((body.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n'));
    if (completions === 1) await new Promise<void>((resolve) => { gate.release = resolve; });
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `A${completions}` }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const chat = new AgentChatService(taskService);
  try {
    const agent = await taskService.createAgent({
      name: '不泄漏',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    const conversation = await chat.createConversation({ agentId: agent.id });

    /*
     * The ordering has to be deterministic, not a race.
     *
     * The first turn is started and held open; the next two are then accepted
     * while it is still running, so both are queued in the record before any of
     * them is promoted. A probe that spaces the posts out can miss the leak
     * entirely, because a later question may not be recorded until after the
     * earlier prompt was already built.
     */
    const first = await chat.postMessage(conversation.id, { text: '问题0', idempotencyKey: 'q0' });
    assert.notEqual(first.assistantMessage.taskId, null, 'the first turn starts immediately');
    for (let attempt = 0; attempt < 200 && prompts.length < 1; attempt += 1) {
      chat.view(conversation.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(prompts.length, 1, 'the first turn reached the model before the others were sent');

    await chat.postMessage(conversation.id, { text: '问题1', idempotencyKey: 'q1' });
    await chat.postMessage(conversation.id, { text: '问题2', idempotencyKey: 'q2' });

    gate.release?.();
    for (let attempt = 0; attempt < 250 && prompts.length < 3; attempt += 1) {
      chat.view(conversation.id);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    assert.equal(prompts.length, 3, 'all three turns eventually run');
    assert.equal(
      (prompts[1] ?? '').includes('问题2'),
      false,
      'the second prompt must not contain the third question',
    );
    assert.equal(
      (prompts[1] ?? '').includes('问题1'),
      true,
      'the second prompt must contain its own question',
    );
  } finally {
    gate.release?.();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A queue has to advance without a reader.
 *
 * Promotion used to run only from `settleRecord`, which a client drives by
 * reading. A conversation nobody polls therefore never ran its queued turn —
 * the Runtime was depending on a reader to advance its own state machine. The
 * queue now subscribes to task transitions for as long as it exists.
 *
 * No `view()` call appears in this test, by design.
 */
test('a queued turn starts without anyone reading the conversation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-unread-queue-'));
  const prompts: string[] = [];
  let completions = 0;

  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    completions += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: readonly { role: string; content: string }[];
    };
    prompts.push((body.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n'));
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `A${completions}` }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const chat = new AgentChatService(taskService);
  try {
    const agent = await taskService.createAgent({
      name: '无读者',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    const conversation = await chat.createConversation({ agentId: agent.id });

    await chat.postMessage(conversation.id, { text: 'Q0', idempotencyKey: 'q0' });
    await chat.postMessage(conversation.id, { text: 'Q1', idempotencyKey: 'q1' });

    for (let attempt = 0; attempt < 200 && prompts.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(prompts.length, 2, 'the queued turn must run without a read');
    assert.match(prompts[1] ?? '', /A1/, 'and it must see the reply before it');
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The subscription lasts exactly as long as the queue does.
 *
 * Subscribing in the constructor would be simpler and would leak one listener
 * per service instance — a property `agent-chat-stream.test.ts` already guards
 * for the SSE path.
 */
test('a conversation with no queue holds no task-change listener', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-listener-'));
  const providerFetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const chat = new AgentChatService(taskService);
  try {
    const agent = await taskService.createAgent({
      name: '监听器',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    const conversation = await chat.createConversation({ agentId: agent.id });
    assert.equal(taskService.changeListenerCount, 0, 'an idle service subscribes to nothing');

    await chat.postMessage(conversation.id, { text: 'Q0', idempotencyKey: 'q0' });
    await chat.postMessage(conversation.id, { text: 'Q1', idempotencyKey: 'q1' });
    assert.equal(taskService.changeListenerCount, 1, 'a queued conversation subscribes once');

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (taskService.changeListenerCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(taskService.changeListenerCount, 0, 'the listener leaves with the queue');
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Eviction takes the queue with it.
 *
 * A queue is stored beside its conversation, and its subscription lives in
 * `TaskService`. Dropping only the conversation would leave a watcher holding a
 * record nothing references, and a re-loaded conversation would promote turns
 * against a stale queue. The cache is bounded, so the listener count is too.
 */
test('evicting a conversation releases its queue and listener', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-evict-'));
  const providerFetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // Hold every completion so each conversation keeps a non-empty queue.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const chat = new AgentChatService(taskService);
  try {
    const agent = await taskService.createAgent({
      name: '淘汰',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    // More conversations than the cache holds, each with one queued turn.
    for (let index = 0; index < 70; index += 1) {
      const conversation = await chat.createConversation({ agentId: agent.id });
      await chat.postMessage(conversation.id, { text: 'A', idempotencyKey: `a${index}` });
      await chat.postMessage(conversation.id, { text: 'B', idempotencyKey: `b${index}` });
    }
    assert.ok(
      taskService.changeListenerCount <= 64,
      `listeners must be bounded by the cache, got ${taskService.changeListenerCount}`,
    );
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A corrupt queue entry must not take the conversation down with it.
 *
 * The branch that drops a turn whose message pair is missing is unreachable
 * today — records only ever append. It is defensive, and the defence has to be
 * shaped for where it runs: `startNextQueuedTurn` is called from `settleRecord`,
 * which `view()` calls, so throwing there would turn every read of the
 * conversation into a 500. It is also called from the task-change listener,
 * where an exception would reach `notifyChange` and stop the remaining
 * listeners from hearing about the transition. The entry is skipped instead, and
 * the turns behind it still run.
 */
test('a corrupt queue entry is skipped, not thrown, and does not stall the queue', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-orphan-'));
  const prompts: string[] = [];

  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: readonly { role: string; content: string }[];
    };
    prompts.push((body.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: providerFetch,
  });
  const chat = new AgentChatService(taskService);
  try {
    const agent = await taskService.createAgent({
      name: '坏队列',
      instructions: '',
      providerId: 'magpie',
      modelId: 'fixture/chat-model',
    });
    const conversation = await chat.createConversation({ agentId: agent.id });
    await chat.postMessage(conversation.id, { text: 'Q0', idempotencyKey: 'q0' });
    await chat.postMessage(conversation.id, { text: 'Q1', idempotencyKey: 'q1' });

    // Put an entry with no matching messages at the head. The public API cannot
    // produce this, which is why the code path is defensive.
    const internals = chat as unknown as {
      queuedTurns: Map<string, { conversationId: string; userMessageId: string; assistantMessageId: string; text: string; idempotencyKey: string }[]>;
    };
    const queue = internals.queuedTurns.get(conversation.id) ?? [];
    queue.unshift({
      conversationId: conversation.id,
      userMessageId: 'amsg_missing_user',
      assistantMessageId: 'amsg_missing_assistant',
      text: 'ghost',
      idempotencyKey: 'ghost',
    });
    internals.queuedTurns.set(conversation.id, queue);

    /*
     * Read until both real turns are terminal. A read drives settling, so a
     * throw in the promotion path would surface here as a failed read rather
     * than as the assertion below.
     */
    let view = chat.view(conversation.id);
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (view.messages.length === 4 && view.messages.every((message) => message.state === 'replied')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = chat.view(conversation.id);
    }

    assert.equal(prompts.length, 2, 'the real turns behind the corrupt entry still run');
    assert.deepEqual(
      view.messages.map((message) => `${message.author}:${message.state}`),
      ['user:published', 'assistant:replied', 'user:published', 'assistant:replied'],
      'and the conversation still reads cleanly',
    );
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A promotion's release is bound to its own launch, not to the conversation id.
 *
 * An evicted conversation can be re-loaded and promoted while the first launch
 * is still awaiting its task. That first launch's `finally` then runs against a
 * conversation that already has a newer promotion mark. Clearing by id alone
 * would remove the *newer* mark and let a third turn start alongside it.
 *
 * The ordering is asserted directly rather than raced: the mark is set to a
 * newer token, the stale release is applied the way `finally` does, and the
 * newer mark must survive.
 */
test('a stale promotion release leaves a newer mark in place', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-promotion-token-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch,
  });
  const chat = new AgentChatService(taskService);
  try {
    const internals = chat as unknown as { promoting: Map<string, number> };
    assert.ok(internals.promoting instanceof Map, 'promotion marks carry a token');

    const conversationId = 'chat_fixture';
    internals.promoting.set(conversationId, 7);
    // The stale launch releases with the token it was given, not the current one.
    chat.releasePromotion(conversationId, 3);
    assert.equal(internals.promoting.get(conversationId), 7, 'the newer mark survives a stale release');

    // The launch that owns the current mark does clear it.
    chat.releasePromotion(conversationId, 7);
    assert.equal(internals.promoting.has(conversationId), false);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
