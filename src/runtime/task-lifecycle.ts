import type { ConfigurationRevisionId } from './configuration-revision.js';

export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const TERMINAL_TASK_STATES: readonly TaskState[] = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
]);

export type TaskEventType =
  | 'task.queued'
  | 'task.started'
  | 'task.approval_requested'
  | 'task.approved'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancellation_requested'
  | 'task.cancelled';

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  queued: Object.freeze<TaskState[]>(['running', 'cancelling', 'failed']),
  running: Object.freeze<TaskState[]>([
    'waiting_approval',
    'cancelling',
    'succeeded',
    'failed',
  ]),
  waiting_approval: Object.freeze<TaskState[]>([
    'running',
    'cancelling',
    'failed',
  ]),
  cancelling: Object.freeze<TaskState[]>(['cancelled']),
  succeeded: Object.freeze<TaskState[]>([]),
  failed: Object.freeze<TaskState[]>([]),
  cancelled: Object.freeze<TaskState[]>([]),
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
