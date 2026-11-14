import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
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

function calls(items: readonly { readonly name: string; readonly args: Record<string, unknown> }[]): Response {
  return new Response(
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: items.map((item, index) => ({
            index,
            id: `call_00000000000000${index + 1}`,
            type: 'function',
            function: { name: item.name, arguments: JSON.stringify(item.args) },
          })),
        },
      }],
    })}\n\ndata: [DONE]\n\n`,
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

function createService(
  directory: string,
  fetch: typeof globalThis.fetch,
  options: { readonly maxToolCallsPerTurn?: number } = {},
) {
  const read = createBuiltinReadTools({ root: directory });
  const write = createBuiltinWriteTools({ root: directory });
  return new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch },
    catalog(),
    {
      tools: {
        list: () => Object.freeze([...read.list(), ...write.list()]),
        has: (id) => read.has(id) || write.has(id),
        invoke: (id, args) => read.has(id) ? read.invoke(id, args) : write.invoke(id, args),
      },
      ...(options.maxToolCallsPerTurn ? { maxToolCallsPerTurn: options.maxToolCallsPerTurn } : {}),
    },
  );
}

async function waitFor(
  service: TaskService,
  taskId: string,
  predicate: (state: string) => boolean,
): Promise<string> {
  let state = service.store.getTask(taskId)!.state;
  for (let attempt = 0; attempt < 200 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = service.store.getTask(taskId)!.state;
  }
  return state;
}

test('multiple read tools execute in one turn', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-multi-read-'));
  const service = createService(directory, scripted([
    () => calls([
      { name: 'workspace_list', args: { path: '.' } },
      { name: 'workspace_list', args: { path: '.' } },
    ]),
    () => text('done'),
  ]));
  try {
    const agent = await service.createAgent({
      name: '多选题员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'list twice', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    const executed = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('agent_loop.tool_executed' as never));
    assert.equal(executed.length, 2);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('multiple write tools in one turn require one approval per tool', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-multi-write-'));
  const service = createService(directory, scripted([
    () => calls([
      { name: 'workspace_write', args: { path: 'a.txt', content: 'A' } },
      { name: 'workspace_write', args: { path: 'b.txt', content: 'B' } },
    ]),
    () => text('both written'),
  ]));
  try {
    const agent = await service.createAgent({
      name: '多写员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write two files', agentId: agent.id });
    service.startTask(created.id);
    assert.equal(await waitFor(service, created.id, (state) => state === 'waiting_approval'), 'waiting_approval');
    service.decideApproval(created.id, 'approved');
    assert.equal(await waitFor(service, created.id, (state) => state === 'waiting_approval' || state === 'succeeded'), 'waiting_approval');
    assert.equal(readFileSync(path.join(directory, 'a.txt'), 'utf8'), 'A');
    service.decideApproval(created.id, 'approved');
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.equal(readFileSync(path.join(directory, 'b.txt'), 'utf8'), 'B');
    const approvals = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('agent_loop.approval_requested' as never));
    assert.equal(approvals.length, 2);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a turn above the tool-call cap is rejected', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-multi-cap-'));
  const service = createService(directory, scripted([
    () => calls([
      { name: 'workspace_list', args: { path: '.' } },
      { name: 'workspace_list', args: { path: '.' } },
      { name: 'workspace_list', args: { path: '.' } },
    ]),
  ]), { maxToolCallsPerTurn: 2 });
  try {
    const agent = await service.createAgent({
      name: '上限员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'too many', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'failed');
    assert.match(task.error ?? '', /at most|tool calls per turn/i);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
