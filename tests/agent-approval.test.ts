import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools, type ToolProvider } from '../src/runtime/tool-provider.js';
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

function tools(root: string): ToolProvider {
  const read = createBuiltinReadTools({ root });
  const write = createBuiltinWriteTools({ root });
  return {
    list: () => Object.freeze([...read.list(), ...write.list()]),
    has: (id) => read.has(id) || write.has(id),
    invoke: (id, args) => read.has(id) ? read.invoke(id, args) : write.invoke(id, args),
  };
}

async function withService(
  fetch: typeof globalThis.fetch,
  run: (service: TaskService, directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch },
    catalog(),
    { tools: tools(directory) },
  );
  try {
    await run(service, directory);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a write tool pauses the task for approval instead of executing', async () => {
  await withService(scripted([() => toolCall('workspace_write', { path: 'out.txt', content: 'hello' })]), async (service) => {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write a file', agentId: agent.id });
    service.startTask(created.id);
    let task = service.store.getTask(created.id)!;
    for (let attempt = 0; attempt < 100 && task.state === 'queued'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    for (let attempt = 0; attempt < 100 && task.state === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    assert.equal(task.state, 'waiting_approval');
    const events = service.store.listEvents(null).filter((event) => event.taskId === created.id);
    assert.ok(events.some((event) => event.type === ('agent_loop.approval_requested' as never)));
    assert.equal(events.some((event) => event.type === ('agent_loop.tool_executed' as never)), false);
  });
});

test('approving a pending write resumes the loop and executes it once', async () => {
  await withService(
    scripted([
      () => toolCall('workspace_write', { path: 'out.txt', content: 'hello' }),
      () => text('done'),
    ]),
    async (service, directory) => {
      const agent = await service.createAgent({
        name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
      });
      const created = await service.createAgentTask({ prompt: 'write a file', agentId: agent.id });
      service.startTask(created.id);
      let task = service.store.getTask(created.id)!;
      for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        task = service.store.getTask(created.id)!;
      }
      service.decideApproval(created.id, 'approved');
      task = await service.waitForTask(created.id);
      assert.equal(task.state, 'succeeded');
      assert.equal(task.output, 'done');
      assert.equal(readFileSync(path.join(directory, 'out.txt'), 'utf8'), 'hello');
    },
  );
});

test('rejecting a pending write fails the task without writing', async () => {
  await withService(
    scripted([() => toolCall('workspace_write', { path: 'out.txt', content: 'hello' })]),
    async (service, directory) => {
      const agent = await service.createAgent({
        name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
      });
      const created = await service.createAgentTask({ prompt: 'write', agentId: agent.id });
      service.startTask(created.id);
      let task = service.store.getTask(created.id)!;
      for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        task = service.store.getTask(created.id)!;
      }
      service.decideApproval(created.id, 'rejected');
      task = await service.waitForTask(created.id);
      assert.equal(task.state, 'failed');
      assert.equal(existsSync(path.join(directory, 'out.txt')), false);
    },
  );
});

test('a pending approval survives restart and can still be decided', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-restart-'));
  const filename = path.join(directory, 'runtime.sqlite');
  let service = new TaskService(
    new SqliteTaskStore(filename),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([() => toolCall('workspace_write', { path: 'out.txt', content: 'hello' })]),
    },
    catalog(),
    { tools: tools(directory) },
  );
  let taskId: string;
  try {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write', agentId: agent.id });
    taskId = created.id;
    service.startTask(taskId);
    let task = service.store.getTask(taskId)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(taskId)!;
    }
    assert.equal(task.state, 'waiting_approval');
  } finally {
    await service.stop();
  }
  service = new TaskService(
    new SqliteTaskStore(filename),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([() => text('done')]),
    },
    catalog(),
    { tools: tools(directory) },
  );
  try {
    assert.equal(service.store.getTask(taskId)?.state, 'waiting_approval');
    service.decideApproval(taskId, 'approved');
    const finished = await service.waitForTask(taskId);
    assert.equal(finished.state, 'succeeded');
    assert.equal(readFileSync(path.join(directory, 'out.txt'), 'utf8'), 'hello');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the approval route is additive and rejects a second decision', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-route-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([() => toolCall('workspace_write', { path: 'out.txt', content: 'x' }), () => text('ok')]),
    },
    catalog(),
    { tools: tools(directory) },
  );
  const app = createApp({ logger: false, taskService: service });
  try {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await app.inject({ method: 'POST', url: '/v1/tasks', payload: { prompt: 'write', agentId: agent.id } });
    const taskId = created.json().task.id as string;
    let task = service.store.getTask(taskId)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(taskId)!;
    }
    const approved = await app.inject({
      method: 'POST', url: `/v1/tasks/${taskId}/approval`, payload: { decision: 'approved' },
    });
    assert.equal(approved.statusCode, 200);
    const again = await app.inject({
      method: 'POST', url: `/v1/tasks/${taskId}/approval`, payload: { decision: 'approved' },
    });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('after approval the loop may call a read tool again before answering', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-followup-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([
        () => toolCall('workspace_write', { path: 'out.txt', content: 'hello' }),
        () => toolCall('workspace_list', { path: '.' }),
        () => text('done'),
      ]),
    },
    catalog(),
    { tools: tools(directory) },
  );
  try {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write then list', agentId: agent.id });
    service.startTask(created.id);
    let task = service.store.getTask(created.id)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    assert.equal(task.state, 'waiting_approval');
    service.decideApproval(created.id, 'approved');
    task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.equal(task.output, 'done');
    const executed = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('agent_loop.tool_executed' as never));
    assert.equal(executed.length, 2);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a second write request after approval pauses for approval again', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-twice-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([
        () => toolCall('workspace_write', { path: 'a.txt', content: 'one' }),
        () => toolCall('workspace_write', { path: 'b.txt', content: 'two' }),
        () => text('done'),
      ]),
    },
    catalog(),
    { tools: tools(directory) },
  );
  try {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write twice', agentId: agent.id });
    service.startTask(created.id);
    let task = service.store.getTask(created.id)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    service.decideApproval(created.id, 'approved');
    task = service.store.getTask(created.id)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    assert.equal(task.state, 'waiting_approval');
    service.decideApproval(created.id, 'approved');
    task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.equal(readFileSync(path.join(directory, 'a.txt'), 'utf8'), 'one');
    assert.equal(readFileSync(path.join(directory, 'b.txt'), 'utf8'), 'two');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repeating the same write after it already succeeded does not request approval again', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-repeat-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([
        () => toolCall('workspace_write', { path: 'done.txt', content: 'payload' }),
        () => toolCall('workspace_write', { path: 'done.txt', content: 'payload' }),
        () => text('finished'),
      ]),
    },
    catalog(),
    { tools: tools(directory) },
  );
  try {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write once', agentId: agent.id });
    service.startTask(created.id);
    let task = service.store.getTask(created.id)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    service.decideApproval(created.id, 'approved');
    task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.equal(task.output, 'finished');
    const approvals = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('agent_loop.approval_requested' as never));
    assert.equal(approvals.length, 1);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('after approval the loop continues across a second tool turn and another approval', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-chain-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: scripted([
        () => toolCall('workspace_write', { path: 'a.txt', content: 'one' }),
        () => toolCall('workspace_list', { path: '.' }),
        () => toolCall('workspace_write', { path: 'b.txt', content: 'two' }),
        () => text('all done'),
      ]),
    },
    catalog(),
    { tools: tools(directory) },
  );
  try {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'Write files.', providerId: 'magpie', modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write, list, write', agentId: agent.id });
    service.startTask(created.id);
    let task = service.store.getTask(created.id)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    service.decideApproval(created.id, 'approved');
    task = service.store.getTask(created.id)!;
    for (let attempt = 0; attempt < 100 && task.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = service.store.getTask(created.id)!;
    }
    assert.equal(task.state, 'waiting_approval');
    service.decideApproval(created.id, 'approved');
    task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.equal(task.output, 'all done');
    assert.equal(readFileSync(path.join(directory, 'a.txt'), 'utf8'), 'one');
    assert.equal(readFileSync(path.join(directory, 'b.txt'), 'utf8'), 'two');
    const executed = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('agent_loop.tool_executed' as never));
    assert.equal(executed.length, 3);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
