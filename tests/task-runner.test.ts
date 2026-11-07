import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationRevisionStore } from '../src/runtime/configuration-revision.js';
import type { ModelAdapter, ModelAdapterInput, ModelTurn } from '../src/runtime/model-adapter.js';
import type { ToolPolicy } from '../src/runtime/policy-gate.js';
import {
  isTerminalTaskState,
  type TaskEventType,
} from '../src/runtime/task-lifecycle.js';
import {
  runTaskWithModel,
} from '../src/runtime/task-runner.js';
import {
  DENIED_TOOL_CALL,
  FAKE_SECRET_MARKER,
  FINAL_TURN,
  READ_ONLY_TOOL_CALL,
  mutableApprovalSource,
  scriptedModelAdapter,
} from './fixtures/runtime-fixtures.js';

const CONFIGURATION_INPUT = {
  profile: ['default'],
  skills: [],
  policies: ['loopback-only'],
  mcpServers: [],
};

const POLICY: ToolPolicy = {
  allowedTools: ['read_file'],
  approvalRequiredTools: ['write_file'],
};

const revision = createConfigurationRevisionStore(CONFIGURATION_INPUT).active;

function eventTypes(result: Awaited<ReturnType<typeof runTaskWithModel>>): TaskEventType[] {
  return result.events.map((event) => event.type);
}

function runWithTurns(
  turns: readonly ModelTurn[],
  options: {
    readonly approved?: readonly string[];
    readonly signal?: AbortSignal;
    readonly executeTool?: (toolName: string) => string;
  } = {},
) {
  const toolExecutions: string[] = [];

  return {
    toolExecutions,
    result: runTaskWithModel({
      taskId: 'task_fake_model',
      prompt: 'fixture prompt',
      configurationRevisionId: revision.id,
      model: scriptedModelAdapter(turns),
      policy: POLICY,
      approvals: mutableApprovalSource(options.approved ?? []),
      executeTool: options.executeTool ?? ((toolName) => {
        toolExecutions.push(toolName);
        return 'fixture tool output';
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  };
}

test('a provider-independent model run completes through the policy gate', async () => {
  const { result, toolExecutions } = runWithTurns([READ_ONLY_TOOL_CALL, FINAL_TURN]);
  const run = await result;

  assert.equal(run.task.state, 'succeeded');
  assert.equal(run.error, null);
  assert.deepEqual(run.toolExecutions, ['read_file']);
  assert.deepEqual(toolExecutions, ['read_file']);
  assert.deepEqual(eventTypes(run), [
    'task.queued',
    'task.started',
    'task.completed',
  ]);
  assert.ok(run.events.every((event) => event.configurationRevisionId === revision.id));
});

test('a denied later tool leaves the task failed without executing any tool', async () => {
  const { result, toolExecutions } = runWithTurns([
    DENIED_TOOL_CALL,
    READ_ONLY_TOOL_CALL,
  ]);
  const run = await result;

  assert.equal(run.task.state, 'failed');
  assert.match(run.error ?? '', /not authorized: denied/);
  assert.equal(isTerminalTaskState(run.task.state), true);
  assert.deepEqual(run.toolExecutions, []);
  assert.deepEqual(toolExecutions, []);
  assert.deepEqual(eventTypes(run), [
    'task.queued',
    'task.started',
    'task.failed',
  ]);
  assert.equal(JSON.stringify(run.events).includes(FAKE_SECRET_MARKER), false);
});

test('an adapter failure terminates the task before a later tool executes', async () => {
  const failingAdapter: ModelAdapter = {
    async nextTurn(input: ModelAdapterInput): Promise<ModelTurn> {
      assert.equal(input.taskId, 'task_fake_model');
      assert.equal(input.turnIndex, 0);
      throw new Error('fake provider failed');
    },
  };
  const toolExecutions: string[] = [];
  const run = await runTaskWithModel({
    taskId: 'task_fake_model',
    prompt: 'fixture prompt',
    configurationRevisionId: revision.id,
    model: failingAdapter,
    policy: POLICY,
    approvals: mutableApprovalSource([]),
    executeTool: (toolName) => {
      toolExecutions.push(toolName);
      return 'unreachable';
    },
  });

  assert.equal(run.task.state, 'failed');
  assert.equal(run.error, 'fake provider failed');
  assert.deepEqual(run.toolExecutions, []);
  assert.deepEqual(toolExecutions, []);
  assert.deepEqual(eventTypes(run), [
    'task.queued',
    'task.started',
    'task.failed',
  ]);
});

test('cancellation before the first model turn reaches a terminal state', async () => {
  const controller = new AbortController();
  controller.abort();
  const { result, toolExecutions } = runWithTurns(
    [READ_ONLY_TOOL_CALL, FINAL_TURN],
    { signal: controller.signal },
  );
  const run = await result;

  assert.equal(run.task.state, 'cancelled');
  assert.equal(run.error, null);
  assert.deepEqual(run.modelOutputs, []);
  assert.deepEqual(run.toolExecutions, []);
  assert.deepEqual(toolExecutions, []);
  assert.deepEqual(eventTypes(run), [
    'task.queued',
    'task.cancellation_requested',
    'task.cancelled',
  ]);
});

test('cancellation during an active model turn prevents the later tool call', async () => {
  const controller = new AbortController();
  const cancellingAdapter: ModelAdapter = {
    async nextTurn(input): Promise<ModelTurn> {
      assert.equal(input.signal, controller.signal);
      controller.abort();
      return READ_ONLY_TOOL_CALL;
    },
  };
  const toolExecutions: string[] = [];
  const run = await runTaskWithModel({
    taskId: 'task_fake_model',
    prompt: 'fixture prompt',
    configurationRevisionId: revision.id,
    model: cancellingAdapter,
    policy: POLICY,
    approvals: mutableApprovalSource([]),
    executeTool: (toolName) => {
      toolExecutions.push(toolName);
      return 'unreachable';
    },
    signal: controller.signal,
  });

  assert.equal(run.task.state, 'cancelled');
  assert.equal(run.error, null);
  assert.deepEqual(run.modelOutputs, []);
  assert.deepEqual(run.toolExecutions, []);
  assert.deepEqual(toolExecutions, []);
  assert.deepEqual(eventTypes(run), [
    'task.queued',
    'task.started',
    'task.cancellation_requested',
    'task.cancelled',
  ]);
});
