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
