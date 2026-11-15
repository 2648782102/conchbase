import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';
import { createApp } from '../src/http/create-app.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';
import type { ExecutionMode } from '../src/config/runtime-config.js';

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

function twoStepFetch(): typeof globalThis.fetch {
  let turn = 0;
  return (async () => {
    turn += 1;
    return turn === 1 ? toolCall('effect_tool', { target: 'x' }) : text('done');
  }) as typeof globalThis.fetch;
}

function effectTools(invocations: string[]): ToolProvider {
  const definition = (id: string, sideEffect: 'write' | 'external') => Object.freeze({
    id, version: 1 as const, description: `${sideEffect} fixture.`, sideEffect,
  });
  const definitions = [definition('write_tool', 'write'), definition('effect_tool', 'external')];
  return Object.freeze({
    list: () => Object.freeze(definitions),
    has: (toolId: string) => definitions.some((entry) => entry.id === toolId),
    invoke: (toolId: string) => {
      invocations.push(toolId);
      return Object.freeze({ ok: true, summary: `ran ${toolId}`, digest: 'sha256:fixture', bytes: 4 });
    },
  });
}

async function runOnce(
  mode: ExecutionMode,
  toolName: 'write_tool' | 'effect_tool',
  run: (service: TaskService, taskId: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-exec-mode-'));
  const invocations: string[] = [];
  let turn = 0;
  const fetchImpl = (async () => {
    turn += 1;
    return turn === 1 ? toolCall(toolName, {}) : text('done');
  }) as typeof globalThis.fetch;
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: fetchImpl,
      executionMode: mode,
    },
    catalog(),
    { tools: effectTools(invocations) },
  );
  try {
    const agent = await service.createAgent({
      name: '模式测试员',
      instructions: 'Use the tool.',
      providerId: 'magpie',
      modelId: 'fixture/model',
      grantedCapabilities: [
        { kind: 'tool', name: 'write_tool' },
        { kind: 'tool', name: 'effect_tool' },
      ],
    });
    const created = await service.createAgentTask({ prompt: 'do it', agentId: agent.id });
    service.startTask(created.id);
    await run(service, created.id);
    assert.deepEqual(invocations, mode === 'unrestricted' ? [toolName] : []);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForApproval(service: TaskService, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = service.store.getTask(taskId);
    if (task?.state === 'waiting_approval') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Task never reached waiting_approval.');
}

test('restricted mode pauses a write tool for approval', async () => {
  await runOnce('restricted', 'write_tool', async (service, taskId) => {
    await waitForApproval(service, taskId);
  });
});

test('restricted mode also pauses an external tool for approval', async () => {
  await runOnce('restricted', 'effect_tool', async (service, taskId) => {
    await waitForApproval(service, taskId);
  });
});

test('unrestricted mode executes a write tool without entering approval', async () => {
  await runOnce('unrestricted', 'write_tool', async (service, taskId) => {
    const task = await service.waitForTask(taskId);
    assert.equal(task.state, 'succeeded');
    assert.equal(task.output, 'done');
    const events = service.store.listEvents(null).filter((event) => event.taskId === taskId);
    assert.equal(events.some((event) => event.type === ('agent_loop.approval_requested' as never)), false);
    assert.ok(events.some((event) => event.type === ('agent_loop.tool_executed' as never)));
  });
});

test('unrestricted mode executes an external tool without entering approval', async () => {
  await runOnce('unrestricted', 'effect_tool', async (service, taskId) => {
    const task = await service.waitForTask(taskId);
    assert.equal(task.state, 'succeeded');
    const events = service.store.listEvents(null).filter((event) => event.taskId === taskId);
    assert.equal(events.some((event) => event.type === ('agent_loop.approval_requested' as never)), false);
    assert.ok(events.some((event) => event.type === ('agent_loop.tool_executed' as never)));
  });
});

test('unrestricted mode still honours the Agent capability scope', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-exec-scope-'));
  const invocations: string[] = [];
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: twoStepFetch(),
      executionMode: 'unrestricted',
    },
    catalog(),
    { tools: effectTools(invocations) },
  );
  try {
    const agent = await service.createAgent({
      name: '未授权模式员',
      instructions: 'Try a tool.',
      providerId: 'magpie',
      modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'write_tool' }],
    });
    const created = await service.createAgentTask({ prompt: 'do it', agentId: agent.id });
    service.startTask(created.id);
    await service.waitForTask(created.id);
    assert.deepEqual(invocations, [], 'an ungranted external tool must not run even when unrestricted');
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime publishes the execution mode', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-exec-publish-'));
  const config = loadRuntimeConfig({
    CONCHBASE_EXECUTION_MODE: 'unrestricted',
    CONCHBASE_DB: path.join(directory, 'runtime.sqlite'),
  });
  const service = new TaskService(
    new SqliteTaskStore(config.databasePath),
    {
      magpieBaseUrl: config.magpieBaseUrl,
      defaultModel: config.defaultModel,
      executionMode: config.executionMode,
    },
    catalog(),
  );
  const app = createApp({ logger: false, taskService: service, config });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/runtime' });
    const body = response.json<{ executionMode: string; capabilities: string[] }>();
    assert.equal(body.executionMode, 'unrestricted');
    assert.ok(body.capabilities.includes('execution-modes'));
  } finally {
    await app.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('execution mode configuration rejects unknown values', () => {
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_EXECUTION_MODE: 'sometimes' }),
    /must be restricted or unrestricted/,
  );
  assert.equal(loadRuntimeConfig({}).executionMode, 'restricted');
});
