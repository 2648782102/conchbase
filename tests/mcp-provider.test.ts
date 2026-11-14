import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpToolProvider, loadMcpConfig } from '../src/runtime/mcp-provider.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { combineToolProviders, createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

const fixtureServer = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

function config(overrides: Record<string, unknown> = {}) {
  return {
    servers: [{
      id: 'fixture',
      command: process.execPath,
      args: [fixtureServer],
      tools: [
        { name: 'echo', sideEffect: 'read' },
        { name: 'fail', sideEffect: 'read' },
        { name: 'slow', sideEffect: 'read' },
        { name: 'write_thing', sideEffect: 'write' },
      ],
      ...overrides,
    }],
  };
}

test('MCP provider discovers namespaced read tools and calls them', async () => {
  const provider = await createMcpToolProvider(config());
  try {
    const ids = provider.list().map((tool) => tool.id);
    assert.ok(ids.includes('mcp_fixture_echo'));
    assert.ok(ids.includes('mcp_fixture_fail'));
    assert.ok(!ids.includes('mcp_fixture_write_thing'));
    assert.ok(provider.list().every((tool) => tool.sideEffect === 'read'));
    const result = await provider.invoke('mcp_fixture_echo', { text: 'hello' });
    assert.equal(result.ok, true);
    assert.match(result.summary, /echo:hello/);
  } finally {
    await provider.close();
  }
});

test('MCP provider rejects unknown and non-read tools', async () => {
  const provider = await createMcpToolProvider(config());
  try {
    await assert.rejects(async () => provider.invoke('mcp_fixture_missing', {}), /unknown tool|Tool call/i);
    await assert.rejects(async () => provider.invoke('mcp_fixture_write_thing', {}), /unknown tool|Tool call/i);
  } finally {
    await provider.close();
  }
});

test('MCP provider turns server errors into bounded failures', async () => {
  const provider = await createMcpToolProvider(config());
  try {
    await assert.rejects(async () => provider.invoke('mcp_fixture_fail', {}), /mcp_call_failed|Tool call/i);
  } finally {
    await provider.close();
  }
});

test('MCP provider times out a hung tool call', async () => {
  const provider = await createMcpToolProvider(config({ callTimeoutMs: 200 }));
  try {
    await assert.rejects(async () => provider.invoke('mcp_fixture_slow', {}), /mcp_timeout|Tool call/i);
  } finally {
    await provider.close();
  }
});

test('MCP config rejects unsafe or unbounded declarations', () => {
  assert.throws(() => loadMcpConfig({ servers: [{ id: '../x', command: process.execPath, args: [] }] }), /id|server/i);
  assert.throws(() => loadMcpConfig({ servers: [{ id: 'x', command: 'node', args: [], shell: true }] }), /shell|unknown/i);
});

test('MCP provider truncates oversized text results', async () => {
  const provider = await createMcpToolProvider(config({ maxResultBytes: 8 }));
  try {
    const result = await provider.invoke('mcp_fixture_echo', { text: 'x'.repeat(200) });
    assert.ok(result.bytes <= 8);
  } finally {
    await provider.close();
  }
});

test('MCP config file round-trips through the loader', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-mcp-config-'));
  try {
    const file = path.join(directory, 'mcp.json');
    writeFileSync(file, JSON.stringify(config()));
    const loaded = loadMcpConfig(file);
    assert.equal(loaded.servers[0]?.id, 'fixture');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an Agent loop can call an MCP tool and answer with its result', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-mcp-loop-'));
  const mcp = await createMcpToolProvider(config());
  const catalog: ModelCatalogClient = {
    async listModels() {
      return Object.freeze([{ id: 'fixture/model', displayName: 'Fixture' }]);
    },
  };
  const tools = combineToolProviders([
    createBuiltinReadTools({ root: directory }),
    mcp,
  ]);
  let turn = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools?: readonly unknown[] };
    assert.ok(Array.isArray(body.tools));
    turn += 1;
    if (turn === 1) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'call_0000000000000001', type: 'function',
          function: { name: 'mcp_fixture_echo', arguments: '{"text":"hi"}' },
        }] } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '工具返回 echo:hi' } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: fetchImpl },
    catalog,
    { tools },
  );
  try {
    const agent = await service.createAgent({
      name: 'MCP 测试员',
      instructions: 'Use tools.',
      providerId: 'magpie',
      modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'use mcp', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.match(task.output ?? '', /echo:hi/);
    const executed = service.store.listEvents(null)
      .filter((event) => event.type === ('agent_loop.tool_executed' as never));
    assert.equal(executed.length, 1);
  } finally {
    service.close();
    await mcp.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
