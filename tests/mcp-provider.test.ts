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

test('MCP provider registers every declared side-effect class', async () => {
  const provider = await createMcpToolProvider(config());
  try {
    const ids = provider.list().map((tool) => tool.id);
    assert.ok(ids.includes('mcp_fixture_echo'));
    assert.ok(ids.includes('mcp_fixture_fail'));
    assert.ok(ids.includes('mcp_fixture_write_thing'));
    const byId = new Map(provider.list().map((tool) => [tool.id, tool.sideEffect]));
    assert.equal(byId.get('mcp_fixture_echo'), 'read');
    assert.equal(byId.get('mcp_fixture_write_thing'), 'write');
    const result = await provider.invoke('mcp_fixture_echo', { text: 'hello' });
    assert.equal(result.ok, true);
    assert.match(result.summary, /echo:hello/);
  } finally {
    await provider.close();
  }
});

test('MCP provider rejects unknown tools and still invokes declared writes', async () => {
  const provider = await createMcpToolProvider(config());
  try {
    await assert.rejects(async () => provider.invoke('mcp_fixture_missing', {}), /unknown tool|Tool call/i);
    const written = await provider.invoke('mcp_fixture_write_thing', {});
    assert.equal(written.ok, true);
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

test('discovered tools carry their description and input schema to the definition', async () => {
  const provider = await createMcpToolProvider(config({ tools: undefined }));
  try {
    const echo = provider.list().find((tool) => tool.id === 'mcp_fixture_echo');
    assert.ok(echo, 'the discovered echo tool must be registered');
    assert.equal(echo.description, 'Echo the provided text.');
    assert.deepEqual(echo.parameters, {
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  } finally {
    await provider.close();
  }
});

test('an undeclared discovered tool is not assumed to be read-only', async () => {
  const provider = await createMcpToolProvider(config({ tools: undefined }));
  try {
    const echo = provider.list().find((tool) => tool.id === 'mcp_fixture_echo');
    assert.ok(echo);
    // MCP reports no trustworthy side-effect class. Assuming `read` would skip
    // approval, skip the side-effect ledger, and let an identical call be served
    // from cache — for a tool that may have posted a message or moved money.
    assert.equal(echo.sideEffect, 'external');
  } finally {
    await provider.close();
  }
});

test('an operator can still declare discovered tools as read-only', async () => {
  const provider = await createMcpToolProvider(config({ tools: undefined, discoverySideEffect: 'read' }));
  try {
    const echo = provider.list().find((tool) => tool.id === 'mcp_fixture_echo');
    assert.equal(echo?.sideEffect, 'read');
  } finally {
    await provider.close();
  }
});

test('a declared tool description overrides the discovery default', async () => {
  const provider = await createMcpToolProvider({
    servers: [{
      id: 'fixture',
      command: process.execPath,
      args: [fixtureServer],
      tools: [{ name: 'echo', sideEffect: 'read', description: 'Operator override.' }],
    }],
  });
  try {
    const echo = provider.list().find((tool) => tool.id === 'mcp_fixture_echo');
    assert.equal(echo?.description, 'Operator override.');
  } finally {
    await provider.close();
  }
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
      grantedCapabilities: [{ kind: 'tool', name: 'mcp_fixture_echo' }, { kind: 'tool', name: 'mcp_fixture_fail' }, { kind: 'tool', name: 'mcp_fixture_missing' }, { kind: 'tool', name: 'mcp_fixture_slow' }, { kind: 'tool', name: 'mcp_fixture_write_thing' }],
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
