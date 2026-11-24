import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch,
      ...(options.maxToolCallsPerTurn
        ? {
          loopBudget: {
            maxIterations: 6,
            maxToolCallsPerTurn: options.maxToolCallsPerTurn,
            deadlineMs: 120_000,
          },
        }
        : {}),
    },
    catalog(),
    {
      tools: {
        list: () => Object.freeze([...read.list(), ...write.list()]),
        has: (id) => read.has(id) || write.has(id),
        invoke: (id, args) => read.has(id) ? read.invoke(id, args) : write.invoke(id, args),
      },
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

/**
 * A tool's evidence has to survive into durable state.
 *
 * The tool contract promises each result carries bounded facts — counts, paths,
 * sizes — that make its claim checkable later. The event used to record only
 * how many facts there were, so an audit could see that a tool claimed
 * something without seeing what.
 */
test('a tool result carries its evidence facts into the executed event', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-evidence-'));
  const service = createService(directory, scripted([
    () => calls([{ name: 'workspace_list', args: { path: '.' } }]),
    () => text('listed'),
  ]));
  try {
    const agent = await service.createAgent({
      name: '证据员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }],
    });
    const created = await service.createAgentTask({ prompt: 'list', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    const executed = service.store.listEvents(null)
      .find((event) => event.taskId === task.id && event.type === ('agent_loop.tool_executed' as never));
    assert.ok(executed, 'the tool executed');
    // `workspace_list` reports path/totalEntries/returned/hasMore as evidence.
    assert.equal(typeof executed.data['evidence.path'], 'string');
    assert.equal(typeof executed.data['evidence.totalEntries'], 'number');
    assert.ok(Number(executed.data.evidenceFacts) > 0, 'the count agrees with the facts present');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('multiple read tools execute in one turn', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-multi-read-'));
  mkdirSync(path.join(directory, 'sub'));
  const service = createService(directory, scripted([
    // Two distinct reads in one turn must both execute. Identical reads are
    // deduplicated per attempt and covered by tests/read-reuse.test.ts.
    () => calls([
      { name: 'workspace_list', args: { path: '.' } },
      { name: 'workspace_list', args: { path: 'sub' } },
    ]),
    () => text('done'),
  ]));
  try {
    const agent = await service.createAgent({
      name: '多选题员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }, { kind: 'tool', name: 'workspace_write' }],
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
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }, { kind: 'tool', name: 'workspace_write' }],
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
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }, { kind: 'tool', name: 'workspace_write' }],
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

test('a mixed multi-turn chain feeds earlier tool evidence into later decisions', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-mixed-chain-'));
  mkdirSync(path.join(directory, 'notes'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(directory, 'notes', 'a.txt'), 'alpha target\n');
  writeFileSync(path.join(directory, 'notes', 'b.txt'), 'other\n');
  const seenBodies: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    seenBodies.push(body);
    if (seenBodies.length === 1) return calls([{ name: 'workspace_list', args: { path: 'notes' } }]);
    if (seenBodies.length === 2) return calls([{ name: 'workspace_read', args: { path: 'notes/a.txt' } }]);
    if (seenBodies.length === 3) return calls([{ name: 'text_search', args: { path: 'notes', pattern: 'alpha' } }]);
    return text('alpha target is in notes/a.txt');
  }) as typeof globalThis.fetch;
  const service = createService(directory, fetchImpl);
  try {
    const agent = await service.createAgent({
      name: '链路员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [
        { kind: 'tool', name: 'workspace_list' },
        { kind: 'tool', name: 'workspace_read' },
        { kind: 'tool', name: 'text_search' },
      ],
    });
    const created = await service.createAgentTask({ prompt: 'find alpha', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.match(task.output ?? '', /notes\/a\.txt/);
    const executed = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('agent_loop.tool_executed' as never));
    assert.deepEqual(executed.map((event) => event.data.toolId), [
      'workspace_list', 'workspace_read', 'text_search',
    ]);
    assert.equal(seenBodies.length, 4);
    assert.match(seenBodies[2]!, /a\.txt/);
    assert.match(seenBodies[3]!, /alpha target/);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed read can be corrected and the final answer uses the retry result', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-read-retry-'));
  mkdirSync(path.join(directory, 'notes'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(directory, 'notes', 'a.txt'), 'beta target\n');
  const bodies: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    if (bodies.length === 1) return calls([{ name: 'workspace_read', args: { path: 'notes/missing.txt' } }]);
    if (bodies.length === 2) return calls([{ name: 'workspace_list', args: { path: 'notes' } }]);
    if (bodies.length === 3) return calls([{ name: 'workspace_read', args: { path: 'notes/a.txt' } }]);
    return text('beta target is in notes/a.txt');
  }) as typeof globalThis.fetch;
  const service = createService(directory, fetchImpl);
  try {
    const agent = await service.createAgent({
      name: '纠错员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [
        { kind: 'tool', name: 'workspace_read' },
        { kind: 'tool', name: 'workspace_list' },
      ],
    });
    const created = await service.createAgentTask({ prompt: 'find beta', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.match(task.output ?? '', /notes\/a\.txt/);
    const events = service.store.listEvents(null);
    assert.ok(events.some((event) => event.taskId === created.id
      && event.type === ('agent_loop.tool_failed' as never)));
    assert.match(bodies[2]!, /missing\.txt/);
    assert.match(bodies[3]!, /a\.txt/);
    assert.equal(bodies.length, 4);
    assert.match(bodies[3]!, /beta target/);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a write followed by a read in later iterations proves the file contents', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-write-read-'));
  let turn = 0;
  const fetchImpl = (async () => {
    turn += 1;
    if (turn === 1) return calls([{ name: 'workspace_write', args: { path: 'out.txt', content: 'persisted' } }]);
    if (turn === 2) return calls([{ name: 'workspace_read', args: { path: 'out.txt' } }]);
    return text('persisted');
  }) as typeof globalThis.fetch;
  const service = createService(directory, fetchImpl);
  try {
    const agent = await service.createAgent({
      name: '写读员', instructions: 'Write then read.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_write' }, { kind: 'tool', name: 'workspace_read' }],
    });
    const created = await service.createAgentTask({ prompt: 'write and verify', agentId: agent.id });
    service.startTask(created.id);
    assert.equal(await waitFor(service, created.id, (state) => state === 'waiting_approval'), 'waiting_approval');
    service.decideApproval(created.id, 'approved');
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.equal(readFileSync(path.join(directory, 'out.txt'), 'utf8'), 'persisted');
    const events = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('agent_loop.tool_executed' as never));
    assert.deepEqual(events.map((event) => event.data.toolId), ['workspace_write', 'workspace_read']);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a mixed batch keeps exact call order and reports an unknown tool inline', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-mixed-batch-'));
  mkdirSync(path.join(directory, 'notes'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(directory, 'notes', 'a.txt'), 'alpha\n');
  const observed: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const parsed = body.length > 0 ? JSON.parse(body) as { messages?: readonly { role: string; content?: unknown }[] } : {};
    const toolMessages = (parsed.messages ?? []).filter((message: { role: string; content?: unknown }) => message.role === 'tool');
    const toolMessage = toolMessages[toolMessages.length - 1];
    if (toolMessage) observed.push(String(toolMessage.content));
    if (observed.length === 0) {
      return calls([
        { name: 'workspace_list', args: { path: 'notes' } },
        { name: 'not_registered', args: {} },
        { name: 'workspace_read', args: { path: 'notes/a.txt' } },
      ]);
    }
    if (observed.length === 1) return calls([{ name: 'text_search', args: { path: 'notes', pattern: 'alpha' } }]);
    return text('alpha confirmed');
  }) as typeof globalThis.fetch;
  const service = createService(directory, fetchImpl);
  try {
    const agent = await service.createAgent({
      name: '混合批处理器', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [
        { kind: 'tool', name: 'workspace_list' },
        { kind: 'tool', name: 'workspace_read' },
        { kind: 'tool', name: 'text_search' },
      ],
    });
    const created = await service.createAgentTask({ prompt: 'mixed batch', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    const events = service.store.listEvents(null).filter((event) => event.taskId === created.id);
    const ordered = events
      .filter((event) => ['agent_loop.tool_requested', 'agent_loop.tool_executed', 'agent_loop.tool_failed'].includes(String(event.type)))
      .map((event) => `${event.type}:${event.data.toolId}`);
    assert.deepEqual(ordered, [
      'agent_loop.tool_requested:workspace_list',
      'agent_loop.tool_executed:workspace_list',
      'agent_loop.tool_requested:not_registered',
      'agent_loop.tool_failed:not_registered',
      'agent_loop.tool_requested:workspace_read',
      'agent_loop.tool_executed:workspace_read',
      'agent_loop.tool_requested:text_search',
      'agent_loop.tool_executed:text_search',
    ]);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an invalid tool argument fails closed and never reaches the tool', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-invalid-args-'));
  const invoked: string[] = [];
  const service = createService(directory, scripted([
    () => new Response(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{
        index: 0, id: 'call_bad_args', type: 'function',
        function: { name: 'workspace_read', arguments: '{not-json' },
      }] } }],
    })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    () => text('could not read'),
  ]));
  try {
    const agent = await service.createAgent({
      name: '参数员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const created = await service.createAgentTask({ prompt: 'bad args', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'failed');
    const failed = service.store.listEvents(null)
      .filter((event) => event.taskId === created.id && event.type === ('task.failed' as never));
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.data.category, 'provider');
    assert.equal(invoked.length, 0);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
