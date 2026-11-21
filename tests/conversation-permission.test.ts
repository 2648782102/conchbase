import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { narrowPermissionLevel } from '../src/kernel/policy.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

/**
 * A permission dropdown in the composer is a switch for turning approval off
 * unless it can only tighten.
 *
 * The rule under test: a conversation may be stricter than the Runtime and never
 * looser. Everything else here follows from that.
 */
test('a conversation can tighten but never loosen the operator level', () => {
  assert.equal(narrowPermissionLevel('standard', 'strict'), 'strict');
  assert.equal(narrowPermissionLevel('standard', 'trusted'), 'standard', 'trusted must be clamped');
  assert.equal(narrowPermissionLevel('standard', undefined), 'standard');
  assert.equal(narrowPermissionLevel('strict', 'trusted'), 'strict');
  assert.equal(narrowPermissionLevel('strict', 'standard'), 'strict');
  assert.equal(narrowPermissionLevel('trusted', 'standard'), 'standard');
  assert.equal(narrowPermissionLevel('trusted', 'strict'), 'strict');
  assert.equal(narrowPermissionLevel('trusted', 'trusted'), 'trusted');
});

const catalog: ModelCatalogClient = {
  async listModels() {
    return [{ id: 'fixture/chat-model', displayName: 'Fixture' }];
  },
};

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

async function fixture(permissionLevel?: 'strict' | 'standard' | 'trusted') {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-conv-perm-'));
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: (async (input: RequestInfo | URL) => (String(input).endsWith('/v1/models')
      ? new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
      : new Response(sse('ok'), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      }))) as typeof globalThis.fetch,
    ...(permissionLevel ? { permissionLevel } : {}),
  });
  const chat = new AgentChatService(service);
  const agent = await service.createAgent({
    name: '权限员', instructions: '', providerId: 'magpie', modelId: 'fixture/chat-model',
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

test('a conversation that asks for a looser level is clamped and told so', async () => {
  const f = await fixture('standard');
  try {
    // The Runtime is `standard`; the conversation asks for `trusted`.
    const conversation = await f.chat.createConversation({
      agentId: f.agent.id,
      permissionLevel: 'trusted',
    });
    assert.equal(conversation.permissionLevel, 'standard',
      'the client must see what applied, not what it requested');
  } finally {
    await f.cleanup();
  }
});

test('a conversation may choose to be stricter', async () => {
  const f = await fixture('trusted');
  try {
    const conversation = await f.chat.createConversation({
      agentId: f.agent.id,
      permissionLevel: 'strict',
    });
    assert.equal(conversation.permissionLevel, 'strict');
  } finally {
    await f.cleanup();
  }
});

test('the chosen level is pinned across a reload', async () => {
  const f = await fixture('trusted');
  try {
    const conversation = await f.chat.createConversation({
      agentId: f.agent.id,
      permissionLevel: 'standard',
    });
    // A fresh service reads from SQLite, not the in-memory cache.
    const reloaded = new AgentChatService(f.service);
    try {
      assert.equal(reloaded.view(conversation.id).permissionLevel, 'standard');
    } finally {
      reloaded.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('an unrecognised level is rejected rather than defaulted', async () => {
  const f = await fixture('standard');
  try {
    await assert.rejects(
      async () => f.chat.createConversation({ agentId: f.agent.id, permissionLevel: 'sometimes' }),
      /permissionLevel must be/,
    );
  } finally {
    await f.cleanup();
  }
});

test('omitting the level keeps the operator setting, not a pinned copy of it', async () => {
  const f = await fixture('strict');
  try {
    const conversation = await f.chat.createConversation({ agentId: f.agent.id });
    assert.equal(conversation.permissionLevel, 'strict', 'the effective level is still reported');
    // It is reported but not pinned: the stored record stays null so a later
    // operator change applies to this conversation.
    assert.equal(f.service.store.agentChat.get(conversation.id)?.permissionLevel, null);
  } finally {
    await f.cleanup();
  }
});

test('the task carries the conversation level, so the loop agrees with the UI', async () => {
  const f = await fixture('trusted');
  try {
    const conversation = await f.chat.createConversation({
      agentId: f.agent.id,
      permissionLevel: 'strict',
    });
    await f.chat.postMessage(conversation.id, { text: 'hello', idempotencyKey: 'p1' });
    /*
     * Read the pin while the task is alive: the map is released when a task
     * reaches a terminal state, so a finished run legitimately has no entry.
     */
    const pinnedMap = (f.service as unknown as { permissionByTaskId: Map<string, string> })
      .permissionByTaskId;
    let observed: string | undefined;
    for (let tick = 0; tick < 300; tick += 1) {
      const message = f.chat.view(conversation.id).messages[1];
      if (message?.taskId) observed = pinnedMap.get(message.taskId);
      if (observed !== undefined) break;
      if (message?.state === 'replied') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(observed, 'strict', 'the task must run under the conversation level');
    // And once finished, the pin is gone rather than leaking.
    for (let tick = 0; tick < 300; tick += 1) {
      if (f.chat.view(conversation.id).messages[1]?.state === 'replied') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(pinnedMap.size, 0, 'a terminal task releases its pin');
  } finally {
    await f.cleanup();
  }
});

test('pinning a looser level on a task is clamped, not honoured', async () => {
  const f = await fixture('standard');
  try {
    const task = await f.service.createAgentTask({ prompt: 'x', agentId: f.agent.id });
    /*
     * A caller that got the narrowing wrong upstream must not be able to loosen
     * approval here; the setter clamps again.
     */
    f.service.setTaskPermissionLevel(task.id, 'trusted');
    const pinned = (f.service as unknown as { permissionByTaskId: Map<string, string> })
      .permissionByTaskId.get(task.id);
    assert.equal(pinned, 'standard');
  } finally {
    await f.cleanup();
  }
});
