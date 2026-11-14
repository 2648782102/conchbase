import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseConfigurationDocument,
  type ConfigurationDocument,
  type ConfigurationDocumentV2,
} from '../src/runtime/configuration-document.js';
import {
  compositionOutput,
  planCompositionExecution,
} from '../src/runtime/composition-execution.js';
import { TaskService } from '../src/runtime/task-service.js';
import type { AgentDetail, AgentProfileInput, AgentRecord, AgentRevision } from '../src/runtime/agent-profile.js';
import type { AgentTaskCreateInput } from '../src/runtime/task-store.js';
import {
  SqliteTaskStore,
  type ApplyConfigurationResult,
  type ConfigurationState,
  type TaskEventInput,
  type TaskSnapshot,
  type TaskStore,
  type ToolRequestCreateInput,
  type ToolRequestCreateResult,
  type ToolRequestDecisionInput,
  type ToolRequestDecisionResult,
} from '../src/runtime/task-store.js';
import type { RuntimeEvent } from '../src/runtime/event-log.js';
import type { ConfigurationRevision } from '../src/runtime/configuration-document.js';
import type { ConfigurationRevisionId } from '../src/runtime/configuration-document.js';
import type { TaskCreateInput } from '../src/runtime/task-store.js';

interface CompositionFixture {
  readonly nodes: readonly { id: string; label: string }[];
  readonly links: readonly { id: string; from: string; to: string; label: string }[];
  readonly entryNodeIds: readonly string[];
}

const SINGLE_NODE: CompositionFixture = {
  nodes: [{ id: 'node-a', label: 'First node' }],
  links: [],
  entryNodeIds: ['node-a'],
};

const CHAIN: CompositionFixture = {
  nodes: [
    { id: 'node-a', label: 'First node' },
    { id: 'node-b', label: 'Second node' },
    { id: 'node-c', label: 'Third node' },
  ],
  links: [
    { id: 'link-a', from: 'node-a', to: 'node-b', label: 'first connection' },
    { id: 'link-b', from: 'node-b', to: 'node-c', label: 'second connection' },
  ],
  entryNodeIds: ['node-a'],
};

const DIAMOND: CompositionFixture = {
  nodes: [
    { id: 'source', label: 'Source node' },
    { id: 'left', label: 'Left node' },
    { id: 'right', label: 'Right node' },
    { id: 'sink', label: 'Sink node' },
  ],
  links: [
    { id: 'link-source-left', from: 'source', to: 'left', label: 'first branch' },
    { id: 'link-source-right', from: 'source', to: 'right', label: 'second branch' },
    { id: 'link-left-sink', from: 'left', to: 'sink', label: 'first merge' },
    { id: 'link-right-sink', from: 'right', to: 'sink', label: 'second merge' },
  ],
  entryNodeIds: ['source'],
};

const MULTIPLE_ENTRIES: CompositionFixture = {
  nodes: [
    { id: 'entry-a', label: 'First entry' },
    { id: 'entry-b', label: 'Second entry' },
    { id: 'join', label: 'Join node' },
  ],
  links: [
    { id: 'link-a', from: 'entry-a', to: 'join', label: 'first input' },
    { id: 'link-b', from: 'entry-b', to: 'join', label: 'second input' },
  ],
  entryNodeIds: ['entry-b', 'entry-a'],
};

function v2Document(name: string, composition: CompositionFixture): ConfigurationDocumentV2 {
  return parseConfigurationDocument({
    schemaVersion: 2,
    name,
    skills: [],
    policies: [],
    mcpServers: [],
    plugins: [],
    secretRefs: [],
    metadata: { fixture: name },
    composition: {
      schemaVersion: 1,
      name: `${name} composition`,
      nodes: composition.nodes,
      links: composition.links,
      entryNodeIds: composition.entryNodeIds,
      metadata: { shape: name },
    },
  }) as ConfigurationDocumentV2;
}

function v1Document(name: string): ConfigurationDocument {
  return parseConfigurationDocument({
    schemaVersion: 1,
    name,
    skills: [],
    policies: [],
    mcpServers: [],
    plugins: [],
    secretRefs: [],
    metadata: { fixture: name },
  });
}

function providerFetchSpy(): { readonly fetch: typeof globalThis.fetch; calls(): number } {
  let callCount = 0;
  return {
    fetch: (async () => {
      callCount += 1;
      throw new Error('Composition tasks must not call a model provider.');
    }) as typeof globalThis.fetch,
    calls: () => callCount,
  };
}

function withService(
  action: (service: TaskService, filename: string, providerCalls: () => number) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-composition-'));
  const spy = providerFetchSpy();
  const service = new TaskService(new SqliteTaskStore(path.join(directory, 'runtime.sqlite')), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: spy.fetch,
  });
  return action(service, path.join(directory, 'runtime.sqlite'), spy.calls).finally(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

class CancelOnFirstNodeStore implements TaskStore {
  private cancelled = false;
  onFirstNode: (() => void) | undefined;

  constructor(private readonly inner: SqliteTaskStore) {}

  get work() { return this.inner.work; }

  get platform() { return this.inner.platform; }

  get organization() { return this.inner.organization; }

  get agentChat() { return this.inner.agentChat; }

  saveLoopState(taskId: string, state: string | null) { return this.inner.saveLoopState(taskId, state); }
  getLoopState(taskId: string) { return this.inner.getLoopState(taskId); }

  createTask(input: TaskCreateInput): TaskSnapshot {
    return this.inner.createTask(input);
  }

  createAgentTask(input: AgentTaskCreateInput): TaskSnapshot { return this.inner.createAgentTask(input); }
  createAgent(profile: AgentProfileInput): AgentDetail { return this.inner.createAgent(profile); }
  updateAgent(id: string, expected: string, profile: AgentProfileInput): AgentDetail {
    return this.inner.updateAgent(id, expected, profile);
  }
  duplicateAgent(id: string, revision?: string, profile?: AgentProfileInput): AgentDetail {
    return this.inner.duplicateAgent(id, revision, profile);
  }
  archiveAgent(id: string): AgentRecord { return this.inner.archiveAgent(id); }
  applyAgentRevision(id: string, revision: string, expected: string): AgentDetail {
    return this.inner.applyAgentRevision(id, revision, expected);
  }
  setDefaultAgent(id: string | null): string | null { return this.inner.setDefaultAgent(id); }
  listAgents(): readonly AgentRecord[] { return this.inner.listAgents(); }
  getAgent(id: string): AgentDetail | null { return this.inner.getAgent(id); }
  getAgentRevision(id: string, revision: string): AgentRevision | null {
    return this.inner.getAgentRevision(id, revision);
  }

  getTask(taskId: string): TaskSnapshot | null {
    return this.inner.getTask(taskId);
  }

  listTasks(): readonly TaskSnapshot[] {
    return this.inner.listTasks();
  }

  transitionTask(
    taskId: string,
    state: TaskSnapshot['state'],
    event: TaskEventInput,
    patch?: { readonly output?: string; readonly error?: string },
  ): TaskSnapshot {
    return this.inner.transitionTask(taskId, state, event, patch);
  }

  resetTask(taskId: string, attempt: number, event: TaskEventInput): TaskSnapshot {
    return this.inner.resetTask(taskId, attempt, event);
  }

  recordOutputDelta(taskId: string, event: TaskEventInput, partialOutput: string): TaskSnapshot {
    return this.inner.recordOutputDelta(taskId, event, partialOutput);
  }

  recordEvent(taskId: string, event: TaskEventInput): TaskSnapshot {
    const result = this.inner.recordEvent(taskId, event);
    if (!this.cancelled && event.type === 'composition.node_started') {
      this.cancelled = true;
      this.onFirstNode?.();
    }
    return result;
  }

  createToolRequest(input: ToolRequestCreateInput): ToolRequestCreateResult {
    return this.inner.createToolRequest(input);
  }

  getToolRequest(requestId: string) {
    return this.inner.getToolRequest(requestId);
  }

  decideToolRequest(requestId: string, input: ToolRequestDecisionInput): ToolRequestDecisionResult {
    return this.inner.decideToolRequest(requestId, input);
  }

  listEvents(afterEventId: string | null): readonly RuntimeEvent[] {
    return this.inner.listEvents(afterEventId);
  }

  getConfigurationState(): ConfigurationState {
    return this.inner.getConfigurationState();
  }

  getConfigurationRevision(id: string): ConfigurationRevision | null {
    return this.inner.getConfigurationRevision(id);
  }

  applyConfiguration(document: ConfigurationDocument): ApplyConfigurationResult {
    return this.inner.applyConfiguration(document);
  }

  rollbackConfiguration(id: string): ApplyConfigurationResult {
    return this.inner.rollbackConfiguration(id);
  }

  close(): void {
    this.inner.close();
  }
}

test('a single-node composition completes with durable identity and no model call', async () => {
  await withService(async (service, _filename, providerCalls) => {
    const document = v2Document('single', SINGLE_NODE);
    const applied = service.store.applyConfiguration(document);
    const plan = planCompositionExecution(document);
    const task = await service.createTaskAndWait({ prompt: 'ignored by deterministic executor' });

    assert.equal(task.state, 'succeeded');
    assert.equal(task.output, compositionOutput(plan));
    assert.equal(task.partialOutput, null);
    assert.equal(task.configurationRevisionId, applied.state.active.id);
    assert.equal(providerCalls(), 0);

    const events = service.store.listEvents(null);
    assert.deepEqual(events.map((event) => event.type), [
      'task.queued',
      'task.started',
      'composition.started',
      'composition.node_started',
      'composition.node_completed',
      'composition.completed',
      'task.completed',
    ]);
    assert.ok(events.every((event) => event.configurationRevisionId === task.configurationRevisionId));
    assert.ok(events.every((event) => event.attempt === 1));
    assert.equal(events.filter((event) => event.type === 'task.output_delta').length, 0);
    assert.equal(events[2]!.data.compositionDocumentId, plan.compositionDocumentId);
    assert.equal(events[2]!.data.nodeCount, 1);
    assert.equal(events[2]!.data.terminalNodeIds, 'node-a');
    assert.equal(events[3]!.data.compositionNodeId, 'node-a');
    assert.equal(events[3]!.data.nodeIndex, 0);
    assert.equal(events[5]!.data.completedNodeCount, 1);
  });
});

test('chain, fan-out/fan-in, and multiple-entry compositions produce deterministic node orders', async () => {
  await withService(async (service, _filename, providerCalls) => {
    for (const [name, fixture, expectedOrder] of [
      ['chain', CHAIN, ['node-a', 'node-b', 'node-c']],
      ['diamond', DIAMOND, ['source', 'left', 'right', 'sink']],
      ['multiple-entries', MULTIPLE_ENTRIES, ['entry-a', 'entry-b', 'join']],
    ] as const) {
      const document = v2Document(name, fixture);
      const plan = planCompositionExecution(document);
      assert.deepEqual(plan.nodeIds, expectedOrder);
      service.store.applyConfiguration(document);
      const task = await service.createTaskAndWait({ prompt: 'ignored' });
      assert.equal(task.state, 'succeeded');
      assert.equal(task.output, compositionOutput(plan));
      const events = service.store.listEvents(null).filter((event) => event.taskId === task.id);
      assert.deepEqual(
        events.filter((event) => event.type === 'composition.node_started')
          .map((event) => event.data.compositionNodeId),
        expectedOrder,
      );
      assert.deepEqual(
        events.filter((event) => event.type === 'composition.node_completed')
          .map((event) => event.data.compositionNodeId),
        expectedOrder,
      );
      assert.equal(events.at(-1)?.type, 'task.completed');
    }
    assert.equal(providerCalls(), 0);
  });
});

test('retry uses the original pinned v2 configuration after a newer revision is applied', async () => {
  await withService(async (service, _filename, providerCalls) => {
    const original = v2Document('original', CHAIN);
    const applied = service.store.applyConfiguration(original);
    const first = await service.createTaskAndWait({ prompt: 'first' });
    service.store.applyConfiguration(v1Document('later-v1'));
    const retried = service.retryTask(first.id);
    service.startTask(retried.id);
    const second = await service.waitForTask(first.id);

    assert.equal(second.attempt, 2);
    assert.equal(second.configurationRevisionId, applied.state.active.id);
    assert.equal(second.output, first.output);
    const retryEvents = service.store.listEvents(null).filter(
      (event) => event.taskId === first.id && event.attempt === 2,
    );
    assert.deepEqual(
      retryEvents.map((event) => event.type).slice(0, 3),
      ['task.queued', 'task.started', 'composition.started'],
    );
    assert.equal(providerCalls(), 0);
  });
});

test('cancellation stops a node and later nodes without completing them', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-composition-cancel-'));
  const inner = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  const store = new CancelOnFirstNodeStore(inner);
  const spy = providerFetchSpy();
  const service = new TaskService(store, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: spy.fetch,
  });

  try {
    const document = v2Document('cancel-chain', CHAIN);
    service.store.applyConfiguration(document);
    const queued = service.createTask({ prompt: 'ignored' });
    store.onFirstNode = () => service.cancelTask(queued.id);
    service.startTask(queued.id);
    const task = await service.waitForTask(queued.id);

    assert.equal(task.state, 'cancelled');
    assert.equal(task.output, null);
    const types = service.store.listEvents(null)
      .filter((event) => event.taskId === queued.id)
      .map((event) => event.type);
    assert.deepEqual(types, [
      'task.queued',
      'task.started',
      'composition.started',
      'composition.node_started',
      'task.cancellation_requested',
      'composition.node_cancelled',
      'composition.cancelled',
      'task.cancelled',
    ]);
    assert.equal(types.includes('composition.node_completed'), false);
    assert.equal(spy.calls(), 0);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('task ids and pinned revision ids remain branded string values', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-composition-types-'));
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  try {
    const activeId: ConfigurationRevisionId = store.getConfigurationState().active.id;
    assert.match(activeId, /^cfg_[0-9a-f]{24}$/);
    assert.match(store.createTask({
      id: 'task_composition_type',
      prompt: 'ignored',
      model: 'fixture/model',
      configurationRevisionId: activeId,
      attempt: 1,
    }).id, /^task_/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
