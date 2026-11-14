import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import type { OrganizationIntentParser } from '../src/runtime/organization-intent-parser.js';
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

interface Frame {
  readonly id: string | null;
  readonly data: {
    readonly kind: string;
    readonly eventId: string | null;
    readonly messageId: string | null;
    readonly message: { readonly id: string; readonly state: string; readonly body: string } | null;
    readonly conversation: { readonly messages: readonly { readonly id: string }[] } | null;
  };
}

async function readFrames(
  response: Response,
  accept: (frames: readonly Frame[]) => boolean,
  limit = 40,
): Promise<readonly Frame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  while (frames.length < limit) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      if (!block.includes('event: agent-chat')) continue;
      const id = /^id: (.+)$/m.exec(block)?.[1] ?? null;
      const dataLine = /^data: (.+)$/m.exec(block)?.[1];
      if (!dataLine) continue;
      frames.push({ id, data: JSON.parse(dataLine) });
      if (accept(frames)) {
        await reader.cancel();
        return frames;
      }
    }
  }
  await reader.cancel();
  return frames;
}

test('agent chat SSE streams projected tool updates and resumes from a cursor', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-stream-'));
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
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const agent = await service.createAgent({
      name: '流式助手', instructions: 'Write files when asked.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: agent.id },
    });
    const conversationId = created.json().id as string;
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '写一条 note.txt', idempotencyKey: 'stream-1' },
    });
    const assistantId = sent.json().assistantMessage.id as string;
    const taskId = sent.json().assistantMessage.taskId as string;

    const response = await fetch(`${base}/v1/agent-chat/conversations/${conversationId}/events`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');

    const waiting = await readFrames(
      response,
      (frames) => frames.some((frame) =>
        frame.data.kind === 'message'
        && frame.data.messageId === assistantId
        && frame.data.message?.state === 'waiting_approval'),
    );
    assert.equal(waiting[0]?.data.kind, 'snapshot');
    assert.ok(waiting[0]?.data.conversation);
    const approvalFrame = waiting.find((frame) =>
      frame.data.messageId === assistantId && frame.data.message?.state === 'waiting_approval');
    assert.ok(approvalFrame?.id);
    assert.ok(approvalFrame?.data.message);

    const resumed = await fetch(
      `${base}/v1/agent-chat/conversations/${conversationId}/events?after=${approvalFrame.id}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    assert.equal(resumed.status, 200);
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/approval`,
      payload: { assistantMessageId: assistantId, decision: 'approved' },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const frames = await readFrames(
      resumed,
      (entries) => entries.some((frame) =>
        frame.data.messageId === assistantId && frame.data.message?.state === 'replied'),
    );
    assert.equal(frames[0]?.data.kind, 'snapshot');
    const replied = frames.find((frame) => frame.data.message?.state === 'replied');
    assert.equal(replied?.data.message?.body, '已写入 note.txt。');
    const ids = frames.map((frame) => frame.id).filter((id): id is string => id !== null);
    assert.equal(new Set(ids).size, ids.length);

    const unknown = await fetch(
      `${base}/v1/agent-chat/conversations/${conversationId}/events?after=evt_999999999999`,
    );
    assert.equal(unknown.status, 400);
    const malformed = await fetch(
      `${base}/v1/agent-chat/conversations/${conversationId}/events?after=nope`,
    );
    assert.equal(malformed.status, 400);
  } finally {
    await app.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent chat SSE picks up a task created after the stream opened', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-stream-late-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([() => text('稍后回复。')]),
    },
    catalog(),
  );
  const agentChat = new AgentChatService(service);
  const app = createApp({ logger: false, taskService: service, agentChatService: agentChat });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const agent = await service.createAgent({
      name: '稍后助手', instructions: 'Reply.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: agent.id },
    });
    const conversationId = created.json().id as string;
    const response = await fetch(`${base}/v1/agent-chat/conversations/${conversationId}/events`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '稍后回复', idempotencyKey: 'late-stream-1' },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    const assistantId = sent.json().assistantMessage.id as string;
    const frames = await readFrames(response, (entries) => entries.some((frame) =>
      frame.data.messageId === assistantId && frame.data.message?.state === 'replied'));
    assert.ok(frames.some((frame) => frame.data.messageId === assistantId));
    assert.equal(frames.find((frame) => frame.data.messageId === assistantId)?.data.message?.body, '稍后回复。');
  } finally {
    await app.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent chat SSE publishes Boss conversation updates without task ids', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-chat-stream-boss-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([() => text('老板回复：先明确目标。')]),
    },
    catalog(),
  );
  const organization = new InMemoryOrganizationStore();
  const parser: OrganizationIntentParser = {
    async parse(input) {
      return Object.freeze({ version: 1 as const, intentId: input.intentId, actions: Object.freeze([]), relay: '老板回复：先明确目标。' });
    },
  };
  const bossMode = new BossModeService(organization, service, { parser, waitForTasks: false });
  const agentChat = new AgentChatService(service, bossMode);
  const app = createApp({
    logger: false,
    taskService: service,
    organizationStore: organization,
    bossModeService: bossMode,
    agentChatService: agentChat,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await app.inject({
      method: 'POST', url: '/v1/agent-chat/conversations', payload: { agentId: 'boss-agent' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const conversationId = created.json().id as string;
    const response = await fetch(`${base}/v1/agent-chat/conversations/${conversationId}/events`, {
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200);
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/agent-chat/conversations/${conversationId}/messages`,
      payload: { text: '你好', idempotencyKey: 'boss-stream-1' },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    const frames = await readFrames(response, (entries) => entries.some((frame) =>
      frame.data.message?.state === 'replied'
      && frame.data.message.body === '老板回复：先明确目标。'));
    const replied = frames.find((frame) => frame.data.message?.state === 'replied');
    assert.equal(replied?.data.message?.body, '老板回复：先明确目标。');
  } finally {
    await app.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
