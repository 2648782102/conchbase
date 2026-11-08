import type { ConfigurationRevisionId } from './configuration-revision.js';

export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const TERMINAL_TASK_STATES: readonly TaskState[] = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export type TaskEventType =
  | 'task.queued'
  | 'task.started'
  | 'task.output_delta'
  | 'task.approval_requested'
  | 'task.approved'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancellation_requested'
  | 'task.cancelled'
  | 'task.interrupted'
  | 'composition.started'
  | 'composition.node_started'
  | 'composition.node_completed'
  | 'composition.node_cancelled'
  | 'composition.completed'
  | 'composition.cancelled'
  | 'tool.requested'
  | 'tool.approval_required'
  | 'tool.approved'
  | 'tool.rejected'
  | 'tool.executed'
  | 'tool.replayed'
  | 'tool.denied'
  | 'tool.failed';

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  queued: Object.freeze<TaskState[]>([
    'running',
    'cancelling',
    'failed',
    'interrupted',
  ]),
  running: Object.freeze<TaskState[]>([
    'waiting_approval',
    'cancelling',
    'succeeded',
    'failed',
    'interrupted',
  ]),
  waiting_approval: Object.freeze<TaskState[]>([
    'running',
    'cancelling',
    'failed',
    'interrupted',
  ]),
  cancelling: Object.freeze<TaskState[]>(['cancelled', 'interrupted']),
  succeeded: Object.freeze<TaskState[]>([]),
  failed: Object.freeze<TaskState[]>([]),
  cancelled: Object.freeze<TaskState[]>([]),
  interrupted: Object.freeze<TaskState[]>([]),
});

export class InvalidTaskTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export interface TaskRecord {
  readonly id: string;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly state: TaskState;
}

export interface TaskTransition {
  readonly state: TaskState;
  readonly eventType: TaskEventType;
}

export const TASK_TRANSITIONS: Readonly<Record<TaskEventType, TaskTransition>> = Object.freeze({
  'task.queued': { state: 'queued', eventType: 'task.queued' },
  'task.started': { state: 'running', eventType: 'task.started' },
  'task.output_delta': { state: 'running', eventType: 'task.output_delta' },
  'task.approval_requested': {
    state: 'waiting_approval',
    eventType: 'task.approval_requested',
  },
  'task.approved': { state: 'running', eventType: 'task.approved' },
  'task.completed': { state: 'succeeded', eventType: 'task.completed' },
  'task.failed': { state: 'failed', eventType: 'task.failed' },
  'task.cancellation_requested': {
    state: 'cancelling',
    eventType: 'task.cancellation_requested',
  },
  'task.cancelled': { state: 'cancelled', eventType: 'task.cancelled' },
  'task.interrupted': { state: 'interrupted', eventType: 'task.interrupted' },
  'composition.started': { state: 'running', eventType: 'composition.started' },
  'composition.node_started': { state: 'running', eventType: 'composition.node_started' },
  'composition.node_completed': { state: 'running', eventType: 'composition.node_completed' },
  'composition.node_cancelled': {
    state: 'cancelling',
    eventType: 'composition.node_cancelled',
  },
  'composition.completed': { state: 'running', eventType: 'composition.completed' },
  'composition.cancelled': { state: 'cancelling', eventType: 'composition.cancelled' },
  'tool.requested': { state: 'running', eventType: 'tool.requested' },
  'tool.approval_required': { state: 'waiting_approval', eventType: 'tool.approval_required' },
  'tool.approved': { state: 'running', eventType: 'tool.approved' },
  'tool.rejected': { state: 'running', eventType: 'tool.rejected' },
  'tool.executed': { state: 'running', eventType: 'tool.executed' },
  'tool.replayed': { state: 'running', eventType: 'tool.replayed' },
  'tool.denied': { state: 'running', eventType: 'tool.denied' },
  'tool.failed': { state: 'running', eventType: 'tool.failed' },
});

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

export function transitionTask(
  task: TaskRecord,
  eventType: TaskEventType,
): TaskRecord {
  const target = TASK_TRANSITIONS[eventType].state;
  if (!canTransition(task.state, target)) {
    throw new InvalidTaskTransitionError(task.state, target);
  }

  return { ...task, state: target };
}

export function createTaskRecord(
  id: string,
  configurationRevisionId: ConfigurationRevisionId,
): TaskRecord {
  if (id.trim().length === 0) {
    throw new Error('Task id must not be empty.');
  }

  return { id, configurationRevisionId, state: 'queued' };
}
