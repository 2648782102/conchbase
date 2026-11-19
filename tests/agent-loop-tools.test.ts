import assert from 'node:assert/strict';
import test from 'node:test';
import { drainToolCalls, type AgentLoopToolContext } from '../src/runtime/agent-loop-tools.js';
import { ReadResultCache } from '../src/runtime/read-result-cache.js';
import type { ProviderMessage, ProviderToolCall } from '../src/runtime/model-adapter.js';
import type { TaskSnapshot } from '../src/runtime/task-store.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

/**
 * Tool draining in isolation.
 *
 * These ordering rules were previously only observable through a full task run,
 * which made them effectively untested at the unit level. Extracting the loop
 * makes each rule assertable on its own.
 */

const task = {
  id: 'task_1',
  attempt: 1,
  state: 'running',
  configurationRevisionId: 'cfg_1',
  prompt: 'p',
  model: 'm',
} as unknown as TaskSnapshot;

function call(name: string, args: Record<string, string | number | boolean | null> = {}, id = `c_${name}`): ProviderToolCall {
  return { id, name, arguments: args } as unknown as ProviderToolCall;
}

interface Harness {
  readonly context: AgentLoopToolContext;
  readonly events: string[];
  readonly transitions: string[];
  readonly saved: string[];
}

function harness(options: {
  readonly tools?: ToolProvider;
  readonly approval?: (sideEffect: string) => boolean;
  readonly writeApplied?: boolean;
  readonly cache?: ReadResultCache;
} = {}): Harness {
  const events: string[] = [];
  const transitions: string[] = [];
  const saved: string[] = [];
  const context: AgentLoopToolContext = {
    store: {
      saveLoopState: (_id: string, state: string | null) => { saved.push(String(state)); },
      transitionTask: (_id: string, state: string) => { transitions.push(state); return task; },
    } as never,
    readResults: options.cache ?? new ReadResultCache(),
    capabilities: { tools: options.tools, skills: [] },
    needsApproval: options.approval ?? (() => false),
    writeAlreadyApplied: () => options.writeApplied ?? false,
    eventInput: () => ({}),
    requestApproval: (_t, _i, c, sideEffect) => { events.push(`approval:${c.name}:${sideEffect}`); transitions.push('waiting_approval'); },
    recordRequested: (_t, _i, c) => events.push(`requested:${c.name}`),
    recordReused: (_t, _i, c) => events.push(`reused:${c.name}`),
    recordExecuted: (_t, _i, c) => events.push(`executed:${c.name}`),
    recordFailed: (_t, _i, toolId, code) => events.push(`failed:${toolId}:${code}`),
  };
  return { context, events, transitions, saved };
}

function tool(id: string, sideEffect: 'read' | 'write'): ToolProvider {
  return {
    list: () => [{ id, version: 1, description: id, sideEffect }],
    has: (candidate) => candidate === id,
    invoke: () => ({ ok: true, summary: `${id} result`, digest: `sha256:${id}`, bytes: 1 }),
  };
}

test('an ungranted tool is a recorded failure, never executed', async () => {
  const h = harness({ tools: tool('workspace_read', 'read') });
  const messages: ProviderMessage[] = [];
  const outcome = await drainToolCalls(h.context, task, [call('workspace_write')], 0, messages, new AbortController().signal);
  assert.equal(outcome, 'done');
  assert.deepEqual(h.events, ['requested:workspace_write', 'failed:workspace_write:unknown_tool']);
  assert.match(String(messages[0]?.content), /unknown_tool/);
});

test('a consequential tool pauses before it runs', async () => {
  const h = harness({ tools: tool('workspace_write', 'write'), approval: (effect) => effect === 'write' });
  const messages: ProviderMessage[] = [];
  const outcome = await drainToolCalls(h.context, task, [call('workspace_write')], 0, messages, new AbortController().signal);
  assert.equal(outcome, 'paused');
  assert.deepEqual(h.transitions, ['waiting_approval']);
  assert.ok(h.events.some((e) => e.startsWith('approval:workspace_write')), 'approval metadata is recorded');
  assert.equal(h.events.some((e) => e.startsWith('executed:')), false, 'the tool is not executed before approval');
  assert.equal(messages.length, 0, 'nothing is reported to the model until a decision');
});

test('an identical write that already succeeded is refused, not repeated', async () => {
  // Repeating a write after approval would violate the approval the user gave.
  const h = harness({
    tools: tool('workspace_write', 'write'),
    approval: () => true,
    writeApplied: true,
  });
  const messages: ProviderMessage[] = [];
  const outcome = await drainToolCalls(h.context, task, [call('workspace_write')], 0, messages, new AbortController().signal);
  assert.equal(outcome, 'done');
  assert.ok(!h.events.includes('executed:workspace_write'));
  assert.match(String(messages[0]?.content), /already completed/);
});

test('an identical read in the same attempt is reused', async () => {
  const cache = new ReadResultCache();
  const h = harness({ tools: tool('workspace_read', 'read'), cache });
  const messages: ProviderMessage[] = [];
  const signal = new AbortController().signal;
  await drainToolCalls(h.context, task, [call('workspace_read', { path: 'a' })], 0, messages, signal);
  await drainToolCalls(h.context, task, [call('workspace_read', { path: 'a' }, 'c2')], 0, messages, signal);
  assert.deepEqual(h.events, [
    'requested:workspace_read', 'executed:workspace_read',
    'requested:workspace_read', 'reused:workspace_read',
  ]);
  assert.match(String(messages[1]?.content), /reused/);
  assert.match(String(messages[1]?.content), /workspace_read result/, 'the model still sees the content');
});

test('a later attempt does not reuse the earlier attempt read', async () => {
  const cache = new ReadResultCache();
  const h = harness({ tools: tool('workspace_read', 'read'), cache });
  const signal = new AbortController().signal;
  await drainToolCalls(h.context, task, [call('workspace_read', { path: 'a' })], 0, [], signal);
  const retried = { ...task, attempt: 2 } as TaskSnapshot;
  await drainToolCalls(h.context, retried, [call('workspace_read', { path: 'a' })], 0, [], signal);
  assert.ok(h.events.includes('executed:workspace_read'));
  assert.ok(!h.events.includes('reused:workspace_read'), 'a retry must observe fresh data');
});

test('an invoked tool that throws becomes a bounded failure message', async () => {
  const throwing: ToolProvider = {
    list: () => [{ id: 'flaky', version: 1, description: 'f', sideEffect: 'read' }],
    has: (candidate) => candidate === 'flaky',
    invoke: () => { throw new Error('upstream unavailable'); },
  };
  const h = harness({ tools: throwing });
  const messages: ProviderMessage[] = [];
  await drainToolCalls(h.context, task, [call('flaky')], 0, messages, new AbortController().signal);
  assert.deepEqual(h.events, ['requested:flaky', 'failed:flaky:tool_failed']);
  assert.match(String(messages[0]?.content), /tool_failed/);
  assert.doesNotMatch(String(messages[0]?.content), /upstream unavailable/,
    'the raw error text is not forwarded to the model');
});

test('cancellation mid-turn throws instead of continuing', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness({ tools: tool('workspace_read', 'read') });
  await assert.rejects(
    () => drainToolCalls(h.context, task, [call('workspace_read')], 0, [], controller.signal),
    /cancelled/,
  );
  assert.deepEqual(h.events, [], 'nothing is recorded after cancellation');
});

test('every call in a multi-call turn is drained in order', async () => {
  const h = harness({
    tools: {
      list: () => [
        { id: 'workspace_read', version: 1, description: 'r', sideEffect: 'read' },
        { id: 'text_search', version: 1, description: 's', sideEffect: 'read' },
      ],
      has: () => true,
      invoke: (id: string) => ({ ok: true, summary: id, digest: `sha256:${id}`, bytes: 1 }),
    },
  });
  const messages: ProviderMessage[] = [];
  await drainToolCalls(
    h.context, task,
    [call('workspace_read', {}, 'c1'), call('text_search', {}, 'c2')],
    0, messages, new AbortController().signal,
  );
  assert.deepEqual(h.events, [
    'requested:workspace_read', 'executed:workspace_read',
    'requested:text_search', 'executed:text_search',
  ]);
  assert.equal(messages.length, 2);
});
