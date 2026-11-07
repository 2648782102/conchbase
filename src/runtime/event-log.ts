import type { ConfigurationRevisionId } from './configuration-revision.js';
import type { TaskEventType, TaskState } from './task-lifecycle.js';

export interface RuntimeEvent {
  readonly sequence: number;
  readonly id: string;
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly state: TaskState;
  readonly configurationRevisionId: ConfigurationRevisionId;
}

export interface EventAppendInput {
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly state: TaskState;
  readonly configurationRevisionId: ConfigurationRevisionId;
}

function formatEventId(sequence: number): string {
  return `evt_${String(sequence).padStart(12, '0')}`;
}

export class EventOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventOrderError';
  }
}

export interface RuntimeEventLog {
  readonly events: readonly RuntimeEvent[];
}

export function createEventLog(): RuntimeEventLog {
  return { events: Object.freeze([]) };
}

export function appendEvent(
  log: RuntimeEventLog,
  input: EventAppendInput,
): RuntimeEventLog {
  const previous = log.events.at(-1);
  const sequence = previous ? previous.sequence + 1 : 1;
  const event: RuntimeEvent = Object.freeze({
    sequence,
    id: formatEventId(sequence),
    taskId: input.taskId,
    type: input.type,
    state: input.state,
    configurationRevisionId: input.configurationRevisionId,
  });

  return { events: Object.freeze([...log.events, event]) };
}

export function replayEvents(
  log: RuntimeEventLog,
  afterEventId: string | null,
): readonly RuntimeEvent[] {
  if (afterEventId === null) return log.events;

  const after = log.events.find((event) => event.id === afterEventId);
  if (!after) {
    throw new EventOrderError(`Unknown event cursor: ${afterEventId}`);
  }

  return log.events.filter((event) => event.sequence > after.sequence);
}
