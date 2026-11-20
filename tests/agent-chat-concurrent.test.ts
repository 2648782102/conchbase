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
