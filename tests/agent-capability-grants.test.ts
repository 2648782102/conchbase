import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { parseAgentProfile } from '../src/runtime/agent-profile.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
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

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-grants-'));
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'a.txt'), 'alpha\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('an Agent with no grants cannot call a registered tool', async () => {
  const space = workspace();
  const toolCalls: string[][] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      tools?: readonly { function?: { name?: string } }[];
    };
    toolCalls.push((body.tools ?? []).map((tool) => tool.function?.name ?? ''));
    return toolCall('workspace_list', { path: 'notes' });
  }) as typeof globalThis.fetch;
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-grants-db-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: fetchImpl },
    catalog(),
    { tools: createBuiltinReadTools({ root: space.root }) },
  );
  try {
    const agent = await service.createAgent({
      name: '无授权', instructions: 'Try a tool.', providerId: 'magpie', modelId: 'fixture/model',
    });
    assert.deepEqual(agent.current.grantedCapabilities, []);
    const created = await service.createAgentTask({ prompt: 'list notes', agentId: agent.id });
    service.startTask(created.id);
    await service.waitForTask(created.id);
    assert.deepEqual(toolCalls[0], [], 'the provider must not be offered any tool');
    assert.ok(
      service.store.listEvents(null).some((event) => event.type === ('agent_loop.turn_started' as never)),
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    space.cleanup();
  }
});

test('a granted tool is offered and executes, and an ungranted tool resolves as unknown', async () => {
  const space = workspace();
  const offered: string[][] = [];
  let turn = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      tools?: readonly { function?: { name?: string } }[];
    };
    offered.push((body.tools ?? []).map((tool) => tool.function?.name ?? ''));
    turn += 1;
    if (turn === 1) return toolCall('workspace_read', { path: 'notes/a.txt' });
    if (turn === 2) return toolCall('text_search', { path: 'notes', pattern: 'alpha' });
    return text('done');
  }) as typeof globalThis.fetch;
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-grants-db-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: fetchImpl },
    catalog(),
    { tools: createBuiltinReadTools({ root: space.root }) },
  );
  try {
    const agent = await service.createAgent({
      name: '读取员',
      instructions: 'Read a file.',
      providerId: 'magpie',
      modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const created = await service.createAgentTask({ prompt: 'read notes', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.deepEqual(offered[0], ['workspace_read']);
    const events = service.store.listEvents(null).filter((event) => event.taskId === created.id);
    assert.ok(events.some((event) => event.type === ('agent_loop.tool_executed' as never)));
    assert.ok(events.some((event) => event.type === ('agent_loop.tool_failed' as never)
      && event.data.errorCode === 'unknown_tool'));
    assert.equal(task.state, 'succeeded');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    space.cleanup();
  }
});

test('a task keeps the grants of the revision it was pinned to', async () => {
  const space = workspace();
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-grants-db-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: (async () => text('done')) as typeof globalThis.fetch,
    },
    catalog(),
    { tools: createBuiltinReadTools({ root: space.root }) },
  );
  try {
    const agent = await service.createAgent({
      name: '版本化', instructions: 'Read.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const pinnedRevisionId = agent.currentRevisionId;
    const updated = await service.updateAgent(agent.id, {
      expectedRevisionId: pinnedRevisionId,
      profile: {
        name: '版本化', instructions: 'Read.', providerId: 'magpie', modelId: 'fixture/model',
        grantedCapabilities: [],
      },
    });
    assert.deepEqual(updated.current.grantedCapabilities, []);
    const pinned = service.store.getAgentRevision(agent.id, pinnedRevisionId);
    assert.deepEqual(pinned?.grantedCapabilities, [{ kind: 'tool', name: 'workspace_read' }]);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    space.cleanup();
  }
});

test('a grant naming a capability the Runtime does not register is inert', async () => {
  const space = workspace();
  const offered: string[][] = [];
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-grants-db-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          tools?: readonly { function?: { name?: string } }[];
        };
        offered.push((body.tools ?? []).map((tool) => tool.function?.name ?? ''));
        return text('done');
      }) as typeof globalThis.fetch,
    },
    catalog(),
    { tools: createBuiltinReadTools({ root: space.root }) },
  );
  try {
    const agent = await service.createAgent({
      name: '已移除能力', instructions: 'Reply.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [
        { kind: 'tool', name: 'mcp_removed_server_tool' },
        { kind: 'tool', name: 'workspace_list' },
      ],
    });
    const created = await service.createAgentTask({ prompt: 'say hi', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.deepEqual(offered[0], ['workspace_list']);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    space.cleanup();
  }
});

test('Agent API round-trips grants and rejects invalid grant shapes', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-grants-api-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: (async () => text('ok')) as typeof globalThis.fetch,
    },
    catalog(),
  );
  const app = createApp({ logger: false, taskService: service });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: {
        name: '授权员',
        instructions: 'Use granted tools.',
        providerId: 'magpie',
        modelId: 'fixture/model',
        grantedCapabilities: [
          { kind: 'tool', name: 'workspace_read' },
          { kind: 'skill', name: 'release-notes' },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    const agent = created.json<{ agent: { id: string; currentRevisionId: string; current: { grantedCapabilities: unknown[] } } }>().agent;
    assert.deepEqual(agent.current.grantedCapabilities, [
      { kind: 'skill', name: 'release-notes' },
      { kind: 'tool', name: 'workspace_read' },
    ]);

    const detail = await app.inject({ method: 'GET', url: `/v1/agents/${agent.id}` });
    assert.deepEqual(
      detail.json<{ agent: { current: { grantedCapabilities: unknown[] } } }>().agent.current.grantedCapabilities,
      agent.current.grantedCapabilities,
    );

    for (const grantedCapabilities of [
      [{ kind: 'plugin', name: 'x' }],
      [{ kind: 'tool', name: 'UPPER' }],
      [{ kind: 'tool', name: 'a' }, { kind: 'tool', name: 'a' }],
    ]) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { name: 'B', instructions: '', providerId: 'magpie', modelId: 'fixture/model', grantedCapabilities },
      });
      assert.equal(rejected.statusCode, 400, JSON.stringify(grantedCapabilities));
    }

    // Fastify's schema strips undeclared nested fields before the Runtime parser
    // runs, so unknown-field rejection is asserted directly on the parser.
    assert.throws(() => parseAgentProfile({
      name: 'B', instructions: '', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'a', extra: true }],
    }), /unknown field 'extra'/);
  } finally {
    await app.close();
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a user_version 7 database migrates to 8 with empty grants', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-grants-migrate-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const seeded = new SqliteTaskStore(filename);
  const agent = seeded.createAgent({
    name: '旧 Agent', instructions: 'legacy instructions', providerId: 'magpie', modelId: 'fixture/model',
  });
  seeded.close();

  // Rewind the file to the pre-grant shape: drop the additive column and the
  // version marker that ADR 0066 advances.
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    ALTER TABLE agent_revisions DROP COLUMN granted_capabilities;
    PRAGMA user_version = 7;
  `);
  legacy.close();

  const store = new SqliteTaskStore(filename);
  try {
    const revision = store.getAgentRevision(agent.id, agent.currentRevisionId);
    assert.equal(revision?.instructions, 'legacy instructions');
    assert.deepEqual(revision?.grantedCapabilities, []);
  } finally {
    store.close();
    const reopened = new DatabaseSync(filename);
    try {
      assert.equal(
        (reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        8,
      );
    } finally {
      reopened.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
