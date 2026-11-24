import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools, type ToolProvider } from '../src/runtime/tool-provider.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

function sseToolCall(name: string, args: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_fixture',
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\ndata: [DONE]\n\n`;
}

interface Turn {
  readonly text?: string;
  readonly tool?: { readonly name: string; readonly args: Record<string, unknown> };
}

function scriptedFetch(turns: readonly Turn[]): typeof globalThis.fetch {
  let index = 0;
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages?: readonly unknown[];
      tools?: readonly { readonly function?: { readonly name?: string } }[];
    };
    const turn = turns[Math.min(index, turns.length - 1)]!;
    index += 1;
    assert.ok(Array.isArray(body.messages));
    assert.ok(Array.isArray(body.tools));
    assert.ok(body.tools.some((tool) => tool.function?.name === 'workspace_read'));
    if (turn.tool) {
      return new Response(sseToolCall(turn.tool.name, turn.tool.args), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(sse(turn.text ?? 'done'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
}

function withService(
  turns: readonly Turn[],
  tools: ToolProvider,
  run: (service: TaskService, agentId: string) => Promise<void>,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-loop-'));
  const service = new TaskService(new SqliteTaskStore(path.join(directory, 'runtime.sqlite')), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: scriptedFetch(turns),
  }, catalogStub(), { tools });
  return service.createAgent({
    name: '循环测试员',
    instructions: 'Use tools when helpful.',
    providerId: 'magpie',
    modelId: 'fixture/model',
    grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }, { kind: 'tool', name: 'workspace_read' }, { kind: 'tool', name: 'text_search' }],
  }).then((agent) => run(service, agent.id)).finally(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

function catalogStub(): ModelCatalogClient {
  return {
    async listModels() {
      return Object.freeze([{ id: 'fixture/model', displayName: 'Fixture Model' }]);
    },
  };
}

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-workspace-'));
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'a.txt'), 'alpha line\nbeta line\n');
  writeFileSync(path.join(root, 'secret.txt'), 'outside');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a task loops from a tool result back to a final answer', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    await withService([
      { tool: { name: 'workspace_list', args: { path: 'notes' } } },
      { text: '找到 a.txt。' },
    ], tools, async (service, agentId) => {
      const created = await service.createAgentTask({ prompt: '列出 notes 目录', agentId });
      service.startTask(created.id);
      const task = await service.waitForTask(created.id);
      assert.equal(task.state, 'succeeded');
      assert.equal(task.output, '找到 a.txt。');
      const types = service.store.listEvents(null).map((event) => event.type);
      assert.ok(types.includes('agent_loop.tool_executed' as never));
      assert.ok(types.includes('agent_loop.turn_completed' as never));
    });
  } finally {
    space.cleanup();
  }
});

test('the loop stops at its iteration budget instead of spinning', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    await withService([
      { tool: { name: 'workspace_list', args: { path: 'notes' } } },
    ], tools, async (service, agentId) => {
      const created = await service.createAgentTask({ prompt: 'loop', agentId });
      service.startTask(created.id);
      const task = await service.waitForTask(created.id);
      assert.equal(task.state, 'failed');
      assert.match(task.error ?? '', /iteration|budget/i);
    });
  } finally {
    space.cleanup();
  }
});

test('a path outside the workspace root is denied and reported to the model', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    await withService([
      { tool: { name: 'workspace_read', args: { path: '../etc/passwd' } } },
      { text: '无法读取。' },
    ], tools, async (service, agentId) => {
      const created = await service.createAgentTask({ prompt: 'read outside', agentId });
      service.startTask(created.id);
      const task = await service.waitForTask(created.id);
      assert.equal(task.state, 'succeeded');
      const failed = service.store.listEvents(null).filter((event) => event.type === ('agent_loop.tool_failed' as never));
      assert.equal(failed.length, 1);
      assert.doesNotMatch(JSON.stringify(failed), /passwd|outside/);
    });
  } finally {
    space.cleanup();
  }
});

test('a write-capable tool is not registered in v1', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    const ids = tools.list().map((tool) => tool.id);
    assert.deepEqual(ids, ['text_search', 'workspace_list', 'workspace_read']);
    assert.ok(tools.list().every((tool) => tool.sideEffect === 'read'));
  } finally {
    space.cleanup();
  }
});

test('the read tool rejects requests above its byte cap instead of truncating silently', () => {
  const space = workspace();
  try {
    writeFileSync(path.join(space.root, 'large.txt'), 'x'.repeat(64));
    const tools = createBuiltinReadTools({ root: space.root, maxBytes: 16 });
    assert.throws(
      () => tools.invoke('workspace_read', { path: 'large.txt', maxBytes: 1024 }),
      /byte cap|Tool call/i,
    );
  } finally {
    space.cleanup();
  }
});

test('a symlink pointing outside the root is rejected', () => {
  const space = workspace();
  const outside = mkdtempSync(path.join(tmpdir(), 'conchbase-outside-'));
  try {
    writeFileSync(path.join(outside, 'target.txt'), 'outside');
    symlinkSync(path.join(outside, 'target.txt'), path.join(space.root, 'link.txt'));
    const tools = createBuiltinReadTools({ root: space.root });
    assert.throws(
      () => tools.invoke('workspace_read', { path: 'link.txt' }),
      /path|Tool call/i,
    );
  } finally {
    space.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('restarting during a loop interrupts the task without replaying the tool', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-loop-restart-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const space = workspace();
  const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof globalThis.fetch;
  const first = new TaskService(
    new SqliteTaskStore(filename),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: stalled },
    catalogStub(),
    { tools: createBuiltinReadTools({ root: space.root }) },
  );
  let taskId: string;
  try {
    const agent = await first.createAgent({
      name: '重启测试员',
      instructions: 'Use tools.',
      providerId: 'magpie',
      modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }, { kind: 'tool', name: 'workspace_read' }, { kind: 'tool', name: 'text_search' }],
    });
    const created = await first.createAgentTask({ prompt: 'loop', agentId: agent.id });
    taskId = created.id;
    first.startTask(taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await first.stop();
  }
  const second = new TaskService(
    new SqliteTaskStore(filename),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: stubFetch() },
    catalogStub(),
    { tools: createBuiltinReadTools({ root: space.root }) },
  );
  try {
    const task = second.store.getTask(taskId);
    assert.equal(task?.state, 'interrupted');
    const events = second.store.listEvents(null).filter((event) => event.taskId === taskId);
    assert.equal(events.some((event) => event.type === ('agent_loop.tool_executed' as never)), false);
  } finally {
    second.close();
    space.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

function stubFetch(): typeof globalThis.fetch {
  return (async () => new Response(sse('done'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as typeof globalThis.fetch;
}

test('a restart after a completed iteration resumes from its checkpoint', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-loop-resume-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const space = workspace();
  let calls = 0;
  const firstFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      return new Response(sseToolCall('workspace_list', { path: 'notes' }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof globalThis.fetch;
  const loopOptions = {
    tools: createBuiltinReadTools({ root: space.root }),
  };
  const first = new TaskService(
    new SqliteTaskStore(filename),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: firstFetch },
    catalogStub(),
    loopOptions,
  );
  let taskId: string;
  try {
    const agent = await first.createAgent({
      name: '续跑测试员',
      instructions: 'Use tools.',
      providerId: 'magpie',
      modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }],
    });
    const created = await first.createAgentTask({ prompt: 'loop', agentId: agent.id });
    taskId = created.id;
    first.startTask(taskId);
    const deadline = Date.now() + 2000;
    while (!first.store.getLoopState(taskId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(first.store.getLoopState(taskId), 'a checkpoint is written after the first iteration');
  } finally {
    await first.stop();
  }

  const second = new TaskService(
    new SqliteTaskStore(filename),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: stubFetch() },
    catalogStub(),
    loopOptions,
  );
  try {
    const resumed = await second.waitForTask(taskId);
    assert.equal(resumed.state, 'succeeded');
    assert.equal(second.store.getLoopState(taskId), null, 'checkpoint is cleared on completion');
    const types = second.store.listEvents(null)
      .filter((event) => event.taskId === taskId)
      .map((event) => event.type);
    assert.equal(types.filter((type) => type === 'agent_loop.tool_executed').length, 1,
      'the completed iteration is not re-executed');
    assert.ok(types.includes('agent_loop.turn_completed'));
  } finally {
    second.close();
    space.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retry clears a stale continuation checkpoint', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-loop-retry-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const service = new TaskService(
    new SqliteTaskStore(filename),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: stubFetch() },
    catalogStub(),
    {},
  );
  try {
    const created = await service.createTask({ prompt: 'plain' });
    service.startTask(created.id);
    await service.waitForTask(created.id);
    service.store.saveLoopState(created.id, JSON.stringify({ version: 1, iteration: 2, messages: [] }));
    service.retryTask(created.id);
    assert.equal(service.store.getLoopState(created.id), null);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a ten-iteration run resumes mid-chain without replaying completed tools', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-long-resume-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const space = workspace();
  const calls: string[] = [];
  let turn = 0;
  const fetchUntilFourth = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    turn += 1;
    calls.push(`first-${turn}`);
    if (turn <= 4) {
      return new Response(sseToolCall('workspace_list', { path: turn === 1 ? 'notes' : `notes/${turn}` }), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof globalThis.fetch;
  const loopOptions = { tools: createBuiltinReadTools({ root: space.root }) };
  const first = new TaskService(
    new SqliteTaskStore(filename),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: fetchUntilFourth,
      loopBudget: { maxIterations: 10, maxToolCallsPerTurn: 1, deadlineMs: 120_000 },
    },
    catalogStub(),
    loopOptions,
  );
  let taskId: string;
  try {
    const agent = await first.createAgent({
      name: '长链员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }],
    });
    const created = await first.createAgentTask({ prompt: 'long chain', agentId: agent.id });
    taskId = created.id;
    first.startTask(taskId);
    const deadline = Date.now() + 2000;
    while ((first.store.getTask(taskId)?.state !== 'running') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    while (turn < 3 && Date.now() < deadline + 2000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(first.store.getLoopState(taskId)?.includes('iteration'), 'a mid-chain checkpoint exists');
  } finally {
    await first.stop();
  }

  const second = new TaskService(
    new SqliteTaskStore(filename),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: stubFetch(),
      loopBudget: { maxIterations: 10, maxToolCallsPerTurn: 1, deadlineMs: 120_000 },
    },
    catalogStub(),
    loopOptions,
  );
  try {
    const finished = await second.waitForTask(taskId);
    assert.equal(finished.state, 'succeeded', finished.error ?? '');
    const executed = second.store.listEvents(null)
      .filter((event) => event.taskId === taskId && event.type === ('agent_loop.tool_executed' as never));
    assert.ok(executed.length >= 1, 'the completed iteration before the restart did execute');
    assert.equal(calls.filter((call) => call.startsWith('first-')).length, 5);
    const resumedEventTypes = second.store.listTaskEvents(taskId).map((event) => event.type);
    assert.ok(resumedEventTypes.some((type) => type === 'task.resumed' || type === 'task.started' || type === 'task.queued'), resumedEventTypes.join(','));
  } finally {
    second.close();
    space.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a legacy approval checkpoint is not treated as a resumable continuation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-loop-legacy-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const first = new TaskService(
    new SqliteTaskStore(filename),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: stubFetch() },
    catalogStub(),
    {},
  );
  let taskId: string;
  try {
    const created = await first.createTask({ prompt: 'plain' });
    taskId = created.id;
    first.store.saveLoopState(taskId, JSON.stringify({ iteration: 1, messages: [], pending: [] }));
  } finally {
    first.close();
  }
  const second = new TaskService(
    new SqliteTaskStore(filename),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: stubFetch() },
    catalogStub(),
    {},
  );
  try {
    // The task never started, so it is re-queued rather than interrupted, and
    // it runs from scratch. A legacy `{ iteration, messages, pending }`
    // checkpoint is not a continuation: resuming from it would replay a prompt
    // with no matching tool results.
    const finished = await second.waitForTask(taskId);
    assert.equal(finished.state, 'succeeded');
    const events = second.store.listTaskEvents(taskId).map((event) => event.type);
    assert.equal(events.includes('task.resumed'), false);
    assert.ok(events.includes('task.started'));
  } finally {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
