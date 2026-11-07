import type { ConfigurationRevisionId } from './configuration-revision.js';
import {
  appendEvent,
  createEventLog,
  type RuntimeEvent,
  type RuntimeEventLog,
} from './event-log.js';
import type { ModelAdapter, ModelAdapterInput } from './model-adapter.js';
import {
  executeToolThroughGate,
  type ToolPolicy,
} from './policy-gate.js';
import {
  createTaskRecord,
  isTerminalTaskState,
  transitionTask,
  type TaskEventType,
  type TaskRecord,
} from './task-lifecycle.js';

export interface ToolApprovalSource {
  isApproved(toolName: string): boolean;
}

export interface TaskRunOptions {
  readonly taskId: string;
  readonly prompt: string;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly model: ModelAdapter;
  readonly policy: ToolPolicy;
  readonly approvals: ToolApprovalSource;
  readonly executeTool: (toolName: string) => string;
  readonly signal?: AbortSignal;
  readonly maxTurns?: number;
}

export interface TaskRunResult {
  readonly task: TaskRecord;
  readonly events: readonly RuntimeEvent[];
  readonly toolExecutions: readonly string[];
  readonly modelOutputs: readonly string[];
  readonly error: string | null;
}

interface MutableRunState {
  task: TaskRecord;
  log: RuntimeEventLog;
  readonly toolExecutions: string[];
  readonly modelOutputs: string[];
}

function appendStateEvent(
  state: MutableRunState,
  eventType: TaskEventType,
): void {
  state.log = appendEvent(state.log, {
    taskId: state.task.id,
    type: eventType,
    state: state.task.state,
    configurationRevisionId: state.task.configurationRevisionId,
    attempt: 1,
  });
}

function transition(
  state: MutableRunState,
  eventType: TaskEventType,
): void {
  state.task = transitionTask(state.task, eventType);
  appendStateEvent(state, eventType);
}

function cancel(state: MutableRunState): void {
  if (isTerminalTaskState(state.task.state)) return;
  if (state.task.state !== 'cancelling') {
    transition(state, 'task.cancellation_requested');
  }
  transition(state, 'task.cancelled');
}

function toResult(state: MutableRunState, error: string | null): TaskRunResult {
  return {
    task: state.task,
    events: state.log.events,
    toolExecutions: Object.freeze([...state.toolExecutions]),
    modelOutputs: Object.freeze([...state.modelOutputs]),
    error,
  };
}

export async function runTaskWithModel(options: TaskRunOptions): Promise<TaskRunResult> {
  const state: MutableRunState = {
    task: createTaskRecord(options.taskId, options.configurationRevisionId),
    log: createEventLog(),
    toolExecutions: [],
    modelOutputs: [],
  };
  appendStateEvent(state, 'task.queued');

  const maxTurns = options.maxTurns ?? 4;

  try {
    if (options.signal?.aborted) {
      cancel(state);
      return toResult(state, null);
    }

    transition(state, 'task.started');

    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
      if (options.signal?.aborted) {
        cancel(state);
        return toResult(state, null);
      }

      const adapterInput: ModelAdapterInput = {
        taskId: options.taskId,
        prompt: options.prompt,
        turnIndex,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const turn = await options.model.nextTurn(adapterInput);

      if (options.signal?.aborted) {
        cancel(state);
        return toResult(state, null);
      }

      state.modelOutputs.push(turn.output);

      if (turn.kind === 'final') {
        transition(state, 'task.completed');
        return toResult(state, null);
      }

      if (turn.toolName.trim().length === 0) {
        throw new Error('Model tool name must not be empty.');
      }

      executeToolThroughGate(
        options.policy,
        {
          toolName: turn.toolName,
          approved: options.approvals.isApproved(turn.toolName),
        },
        (toolName) => {
          const output = options.executeTool(toolName);
          state.toolExecutions.push(toolName);
          return output;
        },
      );
    }

    throw new Error(`Task exceeded ${maxTurns} model turns.`);
  } catch (cause) {
    if (options.signal?.aborted) {
      cancel(state);
      return toResult(state, null);
    }

    if (!isTerminalTaskState(state.task.state)) {
      transition(state, 'task.failed');
    }

    return toResult(
      state,
      cause instanceof Error ? cause.message : 'Task failed',
    );
  }
}
