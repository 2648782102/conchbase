import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

/**
 * The level has to reach the loop, not just the view.
 *
 * A dropdown that changes a label while the tool run ignores it is worse than no
 * dropdown: the reader believes approval is on. This drives a real read tool
 * under two levels and asserts the run differs.
 */
const catalog: ModelCatalogClient = {
  async listModels() {
    return [{ id: 'fixture/chat-model', displayName: 'Fixture', supportsTools: true }];
  },
};

function toolCallSse(id: string, name: string, args: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: null,
    }],
  })}\n\ndata: [DONE]\n\n`;
}

function textSse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

async function fixture(operatorLevel: 'strict' | 'standard' | 'trusted') {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-conv-perm-rt-'));
  const workspace = path.join(directory, 'ws');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'a.txt'), 'alpha');

  let turn = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    turn += 1;
    if (turn === 1) {
      return new Response(toolCallSse('call_1', 'workspace_read', { path: 'a.txt' }), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(textSse('done'), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;

  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fetchImpl,
    permissionLevel: operatorLevel,
  }, { tools: createBuiltinReadTools({ root: workspace }) });
  const chat = new AgentChatService(service);
  const agent = await service.createAgent({
    name: '读工具员', instructions: '', providerId: 'magpie', modelId: 'fixture/chat-model',
    grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
  });
  return {
    service,
    chat,
    agent,
    async cleanup() {
      chat.close();
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function runOnce(f: Awaited<ReturnType<typeof fixture>>, permissionLevel?: 'strict' | 'standard' | 'trusted') {
  const conversation = await f.chat.createConversation({
    agentId: f.agent.id,
    ...(permissionLevel ? { permissionLevel } : {}),
  });
  await f.chat.postMessage(conversation.id, { text: '读取 a.txt', idempotencyKey: 'r1' });
  for (let tick = 0; tick < 400; tick += 1) {
    const state = f.chat.view(conversation.id).messages[1]?.state;
    if (state === 'waiting_approval' || state === 'replied') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return f.chat.view(conversation.id).messages[1]?.state;
}

test('a read tool runs without approval at standard', async () => {
  const f = await fixture('standard');
  try {
    assert.equal(await runOnce(f), 'replied', 'standard allows reads without a prompt');
  } finally {
    await f.cleanup();
  }
});

test('the same read tool needs approval when the conversation is strict', async () => {
  const f = await fixture('standard');
  try {
    assert.equal(await runOnce(f, 'strict'), 'waiting_approval',
      'a strict conversation must gate a read even though the runtime allows it');
  } finally {
    await f.cleanup();
  }
});

test('a conversation cannot opt out of approval the runtime requires', async () => {
  const f = await fixture('strict');
  try {
    // Asking for `trusted` against a `strict` runtime is clamped to `strict`.
    assert.equal(await runOnce(f, 'trusted'), 'waiting_approval');
  } finally {
    await f.cleanup();
  }
});

test('a trusted runtime still lets a strict conversation gate reads', async () => {
  const f = await fixture('trusted');
  try {
    assert.equal(await runOnce(f), 'replied', 'trusted runs reads immediately');
  } finally {
    await f.cleanup();
  }
});
