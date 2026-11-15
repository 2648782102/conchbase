import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

function catalog(): ModelCatalogClient {
  return {
    async listModels() {
      return Object.freeze([{ id: 'fixture/model', displayName: 'Fixture' }]);
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>, id = 'call_1'): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
    index: 0, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }] } }] })}\n\ndata: [DONE]\n\n`;
}

function text(value: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: value } }] })}\n\ndata: [DONE]\n\n`;
}

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function scripted(turns: readonly (() => string)[]): typeof globalThis.fetch {
  let index = 0;
  return (async () => sse(turns[Math.min(index++, turns.length - 1)]!())) as typeof globalThis.fetch;
}

function countingTools(root: string): { tools: ToolProvider; calls: string[] } {
  const base = createBuiltinReadTools({ root });
  const calls: string[] = [];
  return {
    calls,
    tools: {
      list: () => base.list(),
      has: (id) => base.has(id),
      invoke: (id, args) => {
        calls.push(id);
        return base.invoke(id, args);
      },
    },
  };
}

async function withTask(
  turns: readonly (() => string)[],
  run: (service: TaskService, taskId: string, calls: string[]) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-read-reuse-'));
  writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
  writeFileSync(path.join(root, 'b.txt'), 'beta\n');
  const { tools, calls } = countingTools(root);
  const service = new TaskService(
    new SqliteTaskStore(path.join(root, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted(turns),
      executionMode: 'restricted',
      loopBudget: { maxIterations: 8, maxToolCallsPerTurn: 4, deadlineMs: 60_000 },
    },
    catalog(),
    { tools },
  );
  try {
    const agent = await service.createAgent({
      name: '复用检查员',
      instructions: 'Read files.',
      providerId: 'magpie',
      modelId: 'fixture/model',
      grantedCapabilities: [
        { kind: 'tool', name: 'workspace_read' },
        { kind: 'tool', name: 'workspace_list' },
      ],
    });
    const created = await service.createAgentTask({ prompt: 'read', agentId: agent.id });
    service.startTask(created.id);
    await run(service, created.id, calls);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test('an identical read executes once and the repeat is reused', async () => {
  await withTask([
    () => toolCall('workspace_read', { path: 'a.txt' }, 'call_1'),
    () => toolCall('workspace_read', { path: 'a.txt' }, 'call_2'),
    () => text('done'),
  ], async (service, taskId, calls) => {
    const task = await service.waitForTask(taskId);
    assert.equal(task.state, 'succeeded', task.error ?? '');
    assert.deepEqual(calls, ['workspace_read'], 'the tool must execute exactly once');

    const events = service.store.listEvents(null).filter((event) => event.taskId === taskId);
    const executed = events.filter((event) => event.type === 'agent_loop.tool_executed');
    const reused = events.filter((event) => event.type === 'agent_loop.tool_reused');
    assert.equal(executed.length, 1);
    assert.equal(reused.length, 1);
    assert.equal(reused[0]?.data.toolId, 'workspace_read');
    assert.equal(
      reused[0]?.data.resultDigest,
      executed[0]?.data.resultDigest,
      'the reuse must point at the original result',
    );
  });
});

test('different arguments still execute', async () => {
  await withTask([
    () => toolCall('workspace_read', { path: 'a.txt' }, 'call_1'),
    () => toolCall('workspace_read', { path: 'b.txt' }, 'call_2'),
    () => text('done'),
  ], async (service, taskId, calls) => {
    await service.waitForTask(taskId);
    assert.deepEqual(calls, ['workspace_read', 'workspace_read']);
    const events = service.store.listEvents(null).filter((event) => event.taskId === taskId);
    assert.equal(events.filter((event) => event.type === 'agent_loop.tool_reused').length, 0);
  });
});

test('a write tool is never reused', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-read-reuse-write-'));
  try {
    const writes: string[] = [];
    const tools: ToolProvider = {
      list: () => Object.freeze([{
        id: 'fake_write', version: 1 as const, description: 'write', sideEffect: 'write' as const,
      }]),
      has: () => true,
      invoke: () => {
        writes.push('x');
        return Object.freeze({ ok: true, summary: 'wrote', digest: 'sha256:w', bytes: 5 });
      },
    };
    const service = new TaskService(
      new SqliteTaskStore(path.join(root, 'runtime.sqlite')),
      {
        magpieBaseUrl: 'http://127.0.0.1:3425',
        defaultModel: 'fixture/model',
        fetch: scripted([
          () => toolCall('fake_write', {}, 'call_1'),
          () => toolCall('fake_write', {}, 'call_2'),
          () => text('done'),
        ]),
        executionMode: 'unrestricted',
        loopBudget: { maxIterations: 8, maxToolCallsPerTurn: 4, deadlineMs: 60_000 },
      },
      catalog(),
      { tools },
    );
    try {
      const agent = await service.createAgent({
        name: '写入员',
        instructions: 'write',
        providerId: 'magpie',
        modelId: 'fixture/model',
        grantedCapabilities: [{ kind: 'tool', name: 'fake_write' }],
      });
      const created = await service.createAgentTask({ prompt: 'write', agentId: agent.id });
      service.startTask(created.id);
      await service.waitForTask(created.id);
      const events = service.store.listEvents(null).filter((event) => event.taskId === created.id);
      assert.equal(events.filter((event) => event.type === 'agent_loop.tool_reused').length, 0);
    } finally {
      await service.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
