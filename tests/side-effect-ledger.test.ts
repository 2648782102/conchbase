import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

/**
 * The write/event gap.
 *
 * `workspace_write` hits disk, then the Runtime records `tool.executed`. A crash
 * between those two steps leaves a file that exists with no event saying so.
 * Duplicate detection reads events, so it sees nothing and the model's repeat
 * call writes again. The ledger closes that gap by recording intent *before* the
 * effect.
 */
function withStore(run: (store: SqliteTaskStore, directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-side-effect-'));
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  try {
    run(store, directory);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedTask(store: SqliteTaskStore): string {
  const task = store.createTask({
    id: 'task_effect',
    prompt: 'write a file',
    model: 'fixture/model',
    configurationRevisionId: 'cfg_fixture' as never,
    attempt: 1,
  });
  return task.id;
}

test('an effect is new the first time and committed after success', () => {
  withStore((store) => {
    const taskId = seedTask(store);
    const intent = {
      idempotencyKey: `${taskId}:1:workspace_write:sha256:aa`,
      taskId,
      attempt: 1,
      toolId: 'workspace_write',
      argumentsDigest: 'sha256:aa',
    };
    assert.equal(store.beginSideEffect(intent), 'new');
    store.commitSideEffect({ idempotencyKey: intent.idempotencyKey, resultDigest: 'sha256:bb' });
    assert.equal(store.beginSideEffect(intent), 'already-committed');
  });
});

test('an intent left behind by a crash becomes unknown, never silently re-run', () => {
  withStore((store) => {
    const taskId = seedTask(store);
    const intent = {
      idempotencyKey: `${taskId}:1:workspace_write:sha256:cc`,
      taskId,
      attempt: 1,
      toolId: 'workspace_write',
      argumentsDigest: 'sha256:cc',
    };
    assert.equal(store.beginSideEffect(intent), 'new');
    // The process dies here: nothing commits, nothing abandons.
    assert.equal(store.beginSideEffect(intent), 'unknown');
    // Once unknown, it stays unknown: guessing either way is unsafe.
    assert.equal(store.beginSideEffect(intent), 'unknown');
  });
});

test('a rejected call that did nothing can be retried', () => {
  withStore((store) => {
    const taskId = seedTask(store);
    const intent = {
      idempotencyKey: `${taskId}:1:workspace_write:sha256:dd`,
      taskId,
      attempt: 1,
      toolId: 'workspace_write',
      argumentsDigest: 'sha256:dd',
    };
    assert.equal(store.beginSideEffect(intent), 'new');
    store.abandonSideEffect(intent.idempotencyKey);
    assert.equal(store.beginSideEffect(intent), 'new');
  });
});

test('a new attempt is allowed to perform the same effect again', () => {
  withStore((store) => {
    const taskId = seedTask(store);
    const first = {
      idempotencyKey: `${taskId}:1:workspace_write:sha256:ee`,
      taskId,
      attempt: 1,
      toolId: 'workspace_write',
      argumentsDigest: 'sha256:ee',
    };
    store.beginSideEffect(first);
    store.commitSideEffect({ idempotencyKey: first.idempotencyKey, resultDigest: 'sha256:ff' });
    // A retry is attempt 2: a fresh run is legitimate, not a duplicate.
    assert.equal(store.beginSideEffect({ ...first, attempt: 2, idempotencyKey: `${taskId}:2:workspace_write:sha256:ee` }), 'new');
  });
});

/**
 * The ledger has to be wired into the loop, not merely available.
 *
 * Simulates the crash window directly: the tool writes, then the store is told
 * nothing about the outcome, and the same call is attempted again in the same
 * attempt. It must be refused rather than writing a second time.
 */
test('a repeated write inside one attempt is refused after an unrecorded crash', async () => {
  const { createBuiltinWriteTools } = await import('../src/runtime/write-tools.js');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-write-guard-'));
  const root = path.join(directory, 'workspace');
  mkdirSync(root, { recursive: true });
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  try {
    const taskId = seedTask(store);
    const write = createBuiltinWriteTools({ root });
    const args = { path: 'notes.txt', content: 'hello', overwrite: true as const };
    const key = `${taskId}:1:workspace_write:${(await import('../src/runtime/tool-arguments.js')).digestArguments(args)}`;

    // First run: intent recorded, tool writes, then the process "dies" before commit.
    assert.equal(store.beginSideEffect({
      idempotencyKey: key, taskId, attempt: 1,
      toolId: 'workspace_write', argumentsDigest: 'sha256:any',
    }), 'new');
    write.invoke('workspace_write', args);
    assert.equal(readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'hello');

    // Second run in the same attempt must not write again.
    const outcome = store.beginSideEffect({
      idempotencyKey: key, taskId, attempt: 1,
      toolId: 'workspace_write', argumentsDigest: 'sha256:any',
    });
    assert.equal(outcome, 'unknown', 'an unrecorded write must surface as unknown');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Approval resume is a second way into a tool, and it has to ask the same
 * question. This path used to call `invoke` directly, so a task that crashed
 * inside a write would write again as soon as the user approved — while the
 * task reported success.
 */
/**
 * MCP tools are the main case the ledger does not own.
 *
 * The Runtime cannot make a remote server idempotent, so the contract is
 * narrower: an `external` tool is never assumed safe. It pauses for approval in
 * restricted mode, runs exactly once, and is recorded like any other effect.
 */
test('an external tool pauses for approval and runs exactly once', async () => {
  const { createTaskService } = await import('../src/runtime/task-service.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-external-effect-'));
  let invoked = 0;
  const external = {
    list: () => [{ id: 'send_message', version: 1 as const, description: 'send', sideEffect: 'external' as const }],
    has: (id: string) => id === 'send_message',
    invoke: async () => {
      invoked += 1;
      return { ok: true, summary: 'sent', digest: 'sha256:sent', bytes: 4 };
    },
  };
  const toolTurn = () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'c1', type: 'function',
      function: { name: 'send_message', arguments: JSON.stringify({ text: 'hi' }) },
    }] } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const finalTurn = () => new Response(
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return String(init?.body ?? '').includes('"role":"tool"') ? finalTurn() : toolTurn();
  }) as typeof globalThis.fetch;
  const service = createTaskService(
    path.join(directory, 'runtime.sqlite'),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch, executionMode: 'restricted' },
    { tools: external },
  );
  try {
    const agent = await service.createAgent({
      name: 'sender', instructions: 'x', providerId: 'magpie', modelId: 'm',
      grantedCapabilities: [{ kind: 'tool', name: 'send_message' }] as never,
    });
    const task = await service.createAgentTask({ prompt: 'go', agentId: agent.id });
    service.startTask(task.id);
    for (let i = 0; i < 150 && service.store.getTask(task.id)?.state !== 'waiting_approval'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(service.store.getTask(task.id)?.state, 'waiting_approval');
    assert.equal(invoked, 0, 'an external effect must not run before approval');

    service.decideApproval(task.id, 'approved');
    assert.equal((await service.waitForTask(task.id)).state, 'succeeded');
    assert.equal(invoked, 1);
    assert.equal(
      service.store.listTaskEvents(task.id).filter((event) => event.type === 'agent_loop.tool_executed').length,
      1,
    );
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resuming an approval whose effect is unknown fails instead of writing', async () => {
  const { createTaskService } = await import('../src/runtime/task-service.js');
  const { createBuiltinWriteTools } = await import('../src/runtime/write-tools.js');
  const { existsSync, mkdirSync } = await import('node:fs');
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approval-effect-'));
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const write = createBuiltinWriteTools({ root: workspace });
  const toolTurn = () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'c1', type: 'function',
      function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'a.txt', content: 'one', overwrite: true }) },
    }] } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const finalTurn = () => new Response(
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return String(init?.body ?? '').includes('"role":"tool"') ? finalTurn() : toolTurn();
  }) as typeof globalThis.fetch;
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch, executionMode: 'restricted',
  }, { tools: { list: () => write.list(), has: write.has, invoke: write.invoke } });
  try {
    const agent = await service.createAgent({
      name: 'writer', instructions: 'x', providerId: 'magpie', modelId: 'm',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_write' }] as never,
    });
    const task = await service.createAgentTask({ prompt: 'write', agentId: agent.id });
    const args = { path: 'a.txt', content: 'one', overwrite: true as const };
    const digest = (await import('../src/runtime/tool-arguments.js')).digestArguments(args);
    const key = `${task.id}:1:workspace_write:${digest}`;
    service.store.beginSideEffect({ idempotencyKey: key, taskId: task.id, attempt: 1, toolId: 'workspace_write', argumentsDigest: digest });
    // Second begin flips it to `unknown`, as a crash inside the write would.
    service.store.beginSideEffect({ idempotencyKey: key, taskId: task.id, attempt: 1, toolId: 'workspace_write', argumentsDigest: digest });

    service.startTask(task.id);
    for (let i = 0; i < 150 && service.store.getTask(task.id)?.state !== 'waiting_approval'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(service.store.getTask(task.id)?.state, 'waiting_approval');
    service.decideApproval(task.id, 'approved');
    const finished = await service.waitForTask(task.id);

    assert.equal(finished.state, 'failed');
    assert.match(finished.error ?? '', /may not have completed/);
    assert.equal(existsSync(path.join(workspace, 'a.txt')), false, 'the file must not be written');
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
