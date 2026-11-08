import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseConfigurationDocument } from '../src/runtime/configuration-document.js';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import {
  ToolRequestConflictError,
  ToolRequestContextError,
  ToolRequestNotFoundError,
  ToolRequestValidationError,
  parseToolRequestDecision,
  parseToolRequestInput,
  toolArgumentsDigest,
  toolRequestIdempotencyKey,
} from '../src/runtime/tool-request.js';

const V2_DOCUMENT = parseConfigurationDocument({
  schemaVersion: 2,
  name: 'ledger fixture',
  skills: [],
  policies: [],
  mcpServers: [],
  plugins: [],
  secretRefs: [],
  metadata: { fixture: 'ledger' },
  composition: {
    schemaVersion: 1,
    name: 'ledger composition',
    nodes: [
      { id: 'node-a', label: 'First node' },
      { id: 'node-b', label: 'Second node' },
    ],
    links: [{ id: 'link-a', from: 'node-a', to: 'node-b', label: 'connection' }],
    entryNodeIds: ['node-a'],
    metadata: { shape: 'chain' },
  },
});

const V1_DOCUMENT = parseConfigurationDocument({
  schemaVersion: 1,
  name: 'v1 fixture',
  skills: [],
  policies: [],
  mcpServers: [],
  plugins: [],
  secretRefs: [],
  metadata: { fixture: 'v1' },
});

function withService(
  action: (service: TaskService, filename: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-request-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const service = new TaskService(new SqliteTaskStore(filename), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: async () => { throw new Error('Ledger tests must not call a provider.'); },
  });
  return action(service, filename).finally(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

function requestInput(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    attempt: 1,
    compositionNodeId: 'node-a',
    toolCall: {
      toolName: 'fixture_read',
      arguments: { value: 'bounded' },
    },
    ...overrides,
  };
}

test('normalized tool call validation rejects unknown fields and secret-like values', () => {
  assert.throws(
    () => parseToolRequestInput({ ...requestInput('task_1'), unexpected: true }),
    ToolRequestValidationError,
  );
  assert.throws(
    () => parseToolRequestInput(requestInput('task_1', {
      toolCall: { toolName: 'fixture_read', arguments: { api_key: 'secret' } },
    })),
    ToolRequestValidationError,
  );
  assert.throws(
    () => parseToolRequestDecision({ decision: 'approved', reason: 'sk-not-a-real-credential' }),
    ToolRequestValidationError,
  );
  assert.throws(
    () => parseToolRequestDecision({ decision: 'maybe', reason: 'bounded' }),
    ToolRequestValidationError,
  );
});

test('versioned identity digests are stable and bound to the full scope', () => {
  const argsDigest = toolArgumentsDigest({ b: 2, a: 'one' });
  assert.equal(argsDigest, toolArgumentsDigest({ a: 'one', b: 2 }));
  const base = {
    taskId: 'task_1',
    attempt: 1,
    configurationRevisionId: 'cfg_000000000000000000000001',
    compositionDocumentId: 'cmp_000000000000000000000001' as never,
    compositionNodeId: 'node-a',
    toolName: 'fixture_read',
    argumentsDigest: argsDigest,
  };
  const key = toolRequestIdempotencyKey(base);
  assert.equal(key, toolRequestIdempotencyKey({ ...base }));
  assert.notEqual(key, toolRequestIdempotencyKey({ ...base, attempt: 2 }));
  assert.notEqual(key, toolRequestIdempotencyKey({ ...base, compositionNodeId: 'node-b' }));
});

test('a v2 task creates durable pending ledger records and idempotent replay adds no events', async () => {
  await withService(async (service) => {
    service.store.applyConfiguration(V2_DOCUMENT);
    const task = service.createTask({ prompt: 'ignored' });
    const first = service.createToolRequest(requestInput(task.id));
    assert.equal(first.created, true);
    assert.equal(first.request.status, 'pending');
    assert.match(first.request.id, /^tqr_[0-9a-f]{24}$/);
    assert.match(first.request.compositionDocumentId, /^cmp_[0-9a-f]{24}$/);
    assert.match(first.request.argumentsDigest, /^arg_[0-9a-f]{24}$/);
    assert.match(first.request.idempotencyKey, /^idem_[0-9a-f]{24}$/);

    const events = service.store.listEvents(null).filter((event) => event.taskId === task.id);
    assert.deepEqual(events.map((event) => event.type), [
      'task.queued',
      'tool.requested',
      'tool.approval_required',
    ]);
    assert.equal(events[1]!.data.toolRequestId, first.request.id);
    assert.equal(events[1]!.data.compositionNodeId, 'node-a');

    const replay = service.createToolRequest(requestInput(task.id));
    assert.equal(replay.created, false);
    assert.deepEqual(replay.request, first.request);
    assert.equal(service.store.listEvents(null).filter((event) => event.taskId === task.id).length, 3);
  });
});

test('approval decisions persist, replay, and reject conflicting decisions', async () => {
  await withService(async (service, filename) => {
    service.store.applyConfiguration(V2_DOCUMENT);
    const task = service.createTask({ prompt: 'ignored' });
    const created = service.createToolRequest(requestInput(task.id));
    const decision = service.decideToolRequest(created.request.id, {
      decision: 'approved',
      reason: 'bounded local fixture',
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.request.status, 'approved');
    assert.equal(decision.request.approval?.decision, 'approved');
    assert.match(decision.request.approval!.id, /^tap_[0-9a-f]{24}$/);
    assert.match(decision.request.approval!.reasonDigest, /^rsn_[0-9a-f]{24}$/);

    const types = service.store.listEvents(null)
      .filter((event) => event.taskId === task.id)
      .map((event) => event.type);
    assert.deepEqual(types, [
      'task.queued',
      'tool.requested',
      'tool.approval_required',
      'tool.approved',
    ]);
    const decisionEvent = service.store.listEvents(null).at(-1)!;
    assert.equal(decisionEvent.data.reasonDigest, decision.request.approval!.reasonDigest);
    assert.equal(JSON.stringify(decisionEvent.data).includes('bounded local fixture'), false);

    const replay = service.decideToolRequest(created.request.id, {
      decision: 'approved',
      reason: 'bounded local fixture',
    });
    assert.equal(replay.changed, false);
    assert.deepEqual(replay.request, decision.request);
    assert.throws(
      () => service.decideToolRequest(created.request.id, {
        decision: 'rejected',
        reason: 'changed decision',
      }),
      ToolRequestConflictError,
    );
    assert.throws(() => service.getToolRequest('tqr_missing'), ToolRequestNotFoundError);
    assert.equal(created.request.id.length > 0, true);
    assert.equal(filename.endsWith('runtime.sqlite'), true);
  });
});

test('tool requests require a v2 pinned revision, matching attempt, eligible state, and declared node', async () => {
  await withService(async (service) => {
    const v1Task = service.createTask({ prompt: 'ignored' });
    assert.throws(
      () => service.createToolRequest(requestInput(v1Task.id)),
      ToolRequestContextError,
    );

    service.store.applyConfiguration(V2_DOCUMENT);
    const v2Task = service.createTask({ prompt: 'ignored' });
    assert.throws(
      () => service.createToolRequest(requestInput(v2Task.id, { attempt: 2 })),
      ToolRequestContextError,
    );
    assert.throws(
      () => service.createToolRequest(requestInput(v2Task.id, { compositionNodeId: 'node-z' })),
      ToolRequestContextError,
    );
    assert.throws(
      () => service.createToolRequest(requestInput('task_missing')),
      /Task not found/,
    );

    service.store.transitionTask(v2Task.id, 'cancelling', {
      taskId: v2Task.id,
      type: 'task.cancellation_requested',
      state: 'cancelling',
      configurationRevisionId: v2Task.configurationRevisionId,
      attempt: v2Task.attempt,
    });
    assert.throws(
      () => service.createToolRequest(requestInput(v2Task.id)),
      ToolRequestContextError,
    );

    service.store.transitionTask(v2Task.id, 'interrupted', {
      taskId: v2Task.id,
      type: 'task.interrupted',
      state: 'interrupted',
      configurationRevisionId: v2Task.configurationRevisionId,
      attempt: v2Task.attempt,
    });
    assert.throws(
      () => service.createToolRequest(requestInput(v2Task.id)),
      ToolRequestContextError,
    );
  });
});
