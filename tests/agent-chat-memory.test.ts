import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentChatMemory,
  createOpenAiCompatibleMemoryProposer,
  parseMemoryProposals,
} from '../src/runtime/agent-chat-memory.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';

const agentId = 'agt_0123456789abcdef01234567';

function proposal(over: Record<string, unknown> = {}) {
  return {
    type: 'preference',
    key: 'reply-style',
    title: '回答偏好',
    body: '用户希望回答先给结论',
    scope: 'agent',
    scopeId: agentId,
    ...over,
  };
}

test('a proposal for another scope or with secret-like content is dropped', () => {
  const accepted = parseMemoryProposals(JSON.stringify({
    memories: [
      proposal(),
      proposal({ key: 'other-agent', scopeId: 'agt_ffffffffffffffffffffffff' }),
      proposal({ key: 'runtime-wide', scope: 'runtime', scopeId: '' }),
      proposal({ key: 'leak', body: 'sk-live-abcdefghijklmnopqrstuvwxyz' }),
      proposal({ key: 'too-big', body: 'x'.repeat(5_000) }),
    ],
  }), agentId);
  assert.deepEqual(accepted.map((entry) => entry.key), ['reply-style'],
    'only the user-owned, non-secret, bounded proposal survives');
});

test('a proposer reply wrapped in prose is still parsed', () => {
  const accepted = parseMemoryProposals(
    `好的，结果如下：\n${JSON.stringify({ memories: [proposal()] })}\n以上。`,
    agentId,
  );
  assert.equal(accepted.length, 1);
});

test('a malformed proposer reply yields nothing instead of throwing', () => {
  assert.deepEqual(parseMemoryProposals('not json', agentId), []);
  assert.deepEqual(parseMemoryProposals('{"memories": "no"}', agentId), []);
  assert.deepEqual(parseMemoryProposals('', agentId), []);
});

test('the index injects only this Agent and runtime-wide facts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-memory-'));
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  try {
    store.memory.write({
      scope: 'agent', scopeId: agentId, type: 'preference', key: 'a',
      title: '我的偏好', body: '简洁', origin: 'conversational', reviewedBy: 'accepted',
    });
    store.memory.write({
      scope: 'agent', scopeId: 'agt_ffffffffffffffffffffffff', type: 'preference', key: 'b',
      title: '别人的偏好', body: '不应出现', origin: 'conversational', reviewedBy: 'accepted',
    });
    store.memory.write({
      scope: 'runtime', scopeId: '', type: 'decision', key: 'c',
      title: '全局约定', body: '每周一同步', origin: 'conversational', reviewedBy: 'accepted',
    });
    const memory = new AgentChatMemory({ memory: store.memory });
    const index = memory.index(agentId);
    assert.match(index, /我的偏好/);
    assert.match(index, /全局约定/);
    assert.doesNotMatch(index, /别人的偏好/, "another Agent's memory must never leak");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('proposals written through the Runtime land in this Agent scope', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-memory-write-'));
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  try {
    const memory = new AgentChatMemory({ memory: store.memory });
    const written = await memory.recordProposals(
      [proposal(), proposal({ key: 'foreign', scopeId: 'agt_ffffffffffffffffffffffff' })].map((entry) =>
        entry as never),
      { agentId, userText: '以后都先给结论', assistantReply: '好的', sourceIntentId: 'chat:test' },
    );
    assert.equal(written.length, 1);
    const stored = store.memory.list({ scope: 'agent', scopeId: agentId, limit: 10 });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.sourceIntentId, 'chat:test', 'every entry keeps its provenance');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failing reviewer writes nothing rather than falling back to trust', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-memory-review-'));
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  try {
    const memory = new AgentChatMemory({
      memory: store.memory,
      reviewer: async () => { throw new Error('reviewer down'); },
    });
    const written = await memory.recordProposals([proposal() as never], {
      agentId, userText: 'u', assistantReply: 'a', sourceIntentId: 'chat:x',
    });
    assert.equal(written.length, 0, 'an unavailable reviewer must fail closed');
    assert.equal(store.memory.list({ scope: 'agent', scopeId: agentId, limit: 10 }).length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the proposer sends a bounded request and parses the answer', async () => {
  let body: Record<string, unknown> | null = null;
  const proposer = createOpenAiCompatibleMemoryProposer({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/model',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ memories: [proposal()] }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch,
  });
  const proposals = await proposer({
    agentId, agentName: '测试', userText: '以后都先给结论', assistantReply: '好的', existingTitles: [],
  });
  assert.equal(proposals.length, 1);
  assert.equal((body as { stream?: unknown } | null)?.stream, false);
});

/**
 * The end-to-end shape: a configured Agent remembers across turns.
 *
 * Before this, memory existed only for the Boss — a person could talk to their
 * own Agent for ten turns and it would start from zero each time.
 */
test('a direct Agent conversation remembers a proposed preference', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-memory-e2e-'));
  const prompts: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: readonly { role: string; content: string }[];
    };
    const system = (request.messages ?? []).find((message) => message.role === 'system')?.content ?? '';
    const user = (request.messages ?? []).filter((message) => message.role === 'user').map((m) => m.content).join('\n');
    if (system.includes('记忆提议器')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ memories: [proposal()] }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (system.includes('记忆审核员')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ decisions: [{ index: 0, verdict: 'accept', reason: 'durable' }] }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    prompts.push(user);
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `回复${prompts.length}` }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fetchImpl,
  });
  const agent = await taskService.createAgent({
    name: '记忆员', instructions: '', providerId: 'magpie', modelId: 'fixture/chat-model',
  });
  const memory = new AgentChatMemory({
    memory: taskService.store.memory,
    reviewer: async () => ({
      version: 1,
      decisions: [{ index: 0, verdict: 'accept', reason: 'durable' }],
    }),
  });
  const chat = new AgentChatService(taskService, undefined, () => new Date().toISOString(), undefined, memory);
  // The proposer here returns a proposal scoped to the Agent created above.
  const proposer = async () => [proposal({ scopeId: agent.id }) as never];
  (chat as unknown as { memoryProposer: unknown }).memoryProposer = proposer;

  try {
    const conversation = await chat.createConversation({ agentId: agent.id });
    await chat.postMessage(conversation.id, { text: '以后回答都先给结论', idempotencyKey: 'm1' });
    for (let tick = 0; tick < 300; tick += 1) {
      if (chat.view(conversation.id).messages[1]?.state === 'replied') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Give the fire-and-forget proposal a moment to land.
    for (let tick = 0; tick < 200; tick += 1) {
      if (taskService.store.memory.list({ scope: 'agent', scopeId: agent.id, limit: 5 }).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stored = taskService.store.memory.list({ scope: 'agent', scopeId: agent.id, limit: 5 });
    assert.equal(stored.length, 1, 'the preference is remembered');

    await chat.postMessage(conversation.id, { text: '第二个问题', idempotencyKey: 'm2' });
    for (let tick = 0; tick < 300; tick += 1) {
      if (chat.view(conversation.id).messages[3]?.state === 'replied') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const secondPrompt = prompts.at(-1) ?? '';
    assert.match(secondPrompt, /回答偏好/, 'the next turn is given the recalled preference');
  } finally {
    chat.close();
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
