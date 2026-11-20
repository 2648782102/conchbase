import assert from 'node:assert/strict';
import test from 'node:test';
import { executeToolCall, type ToolExecutionPorts } from '../src/runtime/tool-execution.js';
import { ToolRejectedError, type ToolSideEffect } from '../src/runtime/tool-provider.js';
import type { ProviderToolCall } from '../src/runtime/model-adapter.js';
import type { TaskSnapshot } from '../src/runtime/task-store.js';

/**
 * The decision order, pinned directly.
 *
 * These rules used to live inline in the agent loop as four `if` blocks over
 * `definition.sideEffect`, with the read check written out three times. That
 * shape is why the order could drift between branches without any test noticing
 * — each branch was only reachable through a full task run.
 */

const task = { id: 'task_1', attempt: 1, state: 'running' } as unknown as TaskSnapshot;
const call: ProviderToolCall = { id: 'c1', name: 'workspace_write', arguments: { path: 'a.txt' } };

interface Recorder {
  readonly order: string[];
  readonly ports: ToolExecutionPorts;
  commitWith: string[];
  abandonCount: number;
  executed: number;
}

function recorder(options: {
  readonly sideEffect: ToolSideEffect;
  readonly needsApproval?: boolean;
  readonly writeApplied?: boolean;
  readonly cached?: { summary: string; digest: string };
  readonly blocked?: string;
  readonly invokeThrows?: unknown;
}): Recorder {
  const order: string[] = [];
  const cache = new Map<string, { summary: string; digest: string }>();
  if (options.cached) cache.set('hit', options.cached);
  const state = { commitWith: [] as string[], abandonCount: 0, executed: 0 };

  const ports: ToolExecutionPorts = {
    needsApproval() { order.push('approval-check'); return options.needsApproval ?? false; },
    writeAlreadyApplied() { order.push('idempotency-check'); return options.writeApplied ?? false; },
    readResults: {
      get() { order.push('read-cache-get'); return options.cached; },
      set() { order.push('read-cache-set'); },
    },
    sideEffect() {
      order.push('side-effect-before');
      if (options.blocked) return { blocked: options.blocked };
      return {
        commit: (digest: string) => { order.push('commit'); state.commitWith.push(digest); },
        abandon: () => { order.push('abandon'); state.abandonCount += 1; },
      };
    },
  };

  return Object.assign(state, { order, ports }) as Recorder;
}

test('approval is decided before idempotency and execution', async () => {
  const r = recorder({ sideEffect: 'write', needsApproval: true });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_write', sideEffect: 'write',
    invoke: async () => { r.executed += 1; return { summary: 'x', digest: 'd', bytes: 1 }; },
  });
  assert.equal(outcome.kind, 'approval_required');
  assert.equal(r.executed, 0, 'nothing runs before approval');
  // The idempotency lookup happens inside the approval branch: an identical
  // write that already landed is refused, not paused for another decision.
  assert.deepEqual(r.order, ['approval-check', 'idempotency-check']);
});

test('an already-applied write is refused instead of paused for approval again', async () => {
  const r = recorder({ sideEffect: 'write', needsApproval: true, writeApplied: true });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_write', sideEffect: 'write',
    invoke: async () => { r.executed += 1; return { summary: 'x', digest: 'd', bytes: 1 }; },
  });
  assert.equal(outcome.kind, 'already_applied');
  assert.equal(r.executed, 0);
  assert.deepEqual(r.order, ['approval-check', 'idempotency-check']);
});

test('a read is served from cache before any side-effect bookkeeping', async () => {
  const r = recorder({
    sideEffect: 'read',
    cached: { summary: 'cached body', digest: 'sha256:cached' },
  });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_read', sideEffect: 'read',
    invoke: async () => { r.executed += 1; return { summary: 'fresh', digest: 'd', bytes: 1 }; },
  });
  assert.equal(outcome.kind, 'reused');
  assert.equal(r.executed, 0, 'the tool is not invoked on a cache hit');
  assert.deepEqual(r.order, ['approval-check', 'read-cache-get']);
});

test('a consequential tool records intent before it runs and commits after', async () => {
  const r = recorder({ sideEffect: 'write' });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_write', sideEffect: 'write',
    invoke: async () => { r.order.push('invoke'); return { summary: 'wrote', digest: 'sha256:x', bytes: 4 }; },
  });
  assert.equal(outcome.kind, 'executed');
  assert.deepEqual(r.order, ['approval-check', 'side-effect-before', 'invoke', 'commit']);
  assert.deepEqual(r.commitWith, ['sha256:x'], 'the commit carries the result digest');
});

test('a read is cached after it runs, never registered as a side effect', async () => {
  const r = recorder({ sideEffect: 'read' });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_read', sideEffect: 'read',
    invoke: async () => { r.order.push('invoke'); return { summary: 'body', digest: 'sha256:r', bytes: 4 }; },
  });
  assert.equal(outcome.kind, 'executed');
  assert.deepEqual(r.order, ['approval-check', 'read-cache-get', 'invoke', 'read-cache-set']);
});

test('an unknown-outcome block fails without invoking the tool', async () => {
  const r = recorder({ sideEffect: 'write', blocked: 'effect_outcome_unknown' });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_write', sideEffect: 'write',
    invoke: async () => { r.executed += 1; return { summary: 'x', digest: 'd', bytes: 1 }; },
  });
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.kind === 'failed' ? outcome.code : null, 'effect_outcome_unknown');
  assert.equal(r.executed, 0, 'a blocked effect must not run');
});

test('a rejection that provably did nothing discards its intent', async () => {
  const r = recorder({ sideEffect: 'write' });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_write', sideEffect: 'write',
    invoke: async () => { throw new ToolRejectedError('invalid_arguments'); },
  });
  assert.equal(outcome.kind, 'failed');
  assert.equal(r.abandonCount, 1, 'the intent is removed so a corrected call is not blocked');
});

test('an unexpected throw keeps the intent and reports tool_failed', async () => {
  const r = recorder({ sideEffect: 'write' });
  const outcome = await executeToolCall(r.ports, task, call, {
    toolId: 'workspace_write', sideEffect: 'write',
    invoke: async () => { throw new Error('disk on fire'); },
  });
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.kind === 'failed' ? outcome.code : null, 'tool_failed');
  assert.equal(r.abandonCount, 0, 'an unknown failure may have applied; keep the intent');
});
