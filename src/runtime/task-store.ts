import { DatabaseSync } from 'node:sqlite';
import type { ConfigurationRevisionId } from './configuration-revision.js';
import { EventOrderError, type RuntimeEvent } from './event-log.js';
import type { TaskEventType, TaskState } from './task-lifecycle.js';

export interface TaskSnapshot {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly state: TaskState;
  readonly attempt: number;
  readonly output: string | null;
  readonly error: string | null;
}

export interface TaskCreateInput {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly attempt: number;
}

export interface TaskEventInput {
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly state: TaskState;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly attempt: number;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TaskStore {
  createTask(input: TaskCreateInput): TaskSnapshot;
  getTask(taskId: string): TaskSnapshot | null;
  listTasks(): readonly TaskSnapshot[];
  transitionTask(
    taskId: string,
    state: TaskState,
    event: TaskEventInput,
    patch?: { readonly output?: string; readonly error?: string },
  ): TaskSnapshot;
  resetTask(taskId: string, attempt: number, event: TaskEventInput): TaskSnapshot;
  listEvents(afterEventId: string | null): readonly RuntimeEvent[];
  close(): void;
}

interface TaskRow {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configuration_revision_id: string;
  readonly state: string;
  readonly attempt: number;
  readonly output: string | null;
  readonly error: string | null;
}

interface EventRow {
  readonly sequence: number;
  readonly id: string;
  readonly task_id: string;
  readonly type: string;
  readonly state: string;
  readonly configuration_revision_id: string;
  readonly attempt: number;
  readonly data: string;
}

export class TaskNotFoundError extends Error {
  constructor() {
    super('Task not found.');
    this.name = 'TaskNotFoundError';
  }
}

export class TaskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskConflictError';
  }
}

function toSnapshot(row: TaskRow): TaskSnapshot {
  return {
    id: row.id,
    prompt: row.prompt,
    model: row.model,
    configurationRevisionId: row.configuration_revision_id as ConfigurationRevisionId,
    state: row.state as TaskState,
    attempt: row.attempt,
    output: row.output,
    error: row.error,
  };
}

function toEvent(row: EventRow): RuntimeEvent {
  let data: Record<string, string | number | boolean | null> = {};
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, string | number | boolean | null>;
    }
  } catch {
    data = {};
  }

  return Object.freeze({
    sequence: row.sequence,
    id: row.id,
    taskId: row.task_id,
    type: row.type as TaskEventType,
    state: row.state as TaskState,
    configurationRevisionId: row.configuration_revision_id as ConfigurationRevisionId,
    attempt: row.attempt,
    data: Object.freeze(data),
  });
}

function formatEventId(sequence: number): string {
  return `evt_${String(sequence).padStart(12, '0')}`;
}

export class SqliteTaskStore implements TaskStore {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          model TEXT NOT NULL,
          configuration_revision_id TEXT NOT NULL,
          state TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          output TEXT,
          error TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          type TEXT NOT NULL,
          state TEXT NOT NULL,
          configuration_revision_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          data TEXT NOT NULL
        ) STRICT;
      `);
    } catch (cause) {
      this.database.close();
      throw cause;
    }
  }

  createTask(input: TaskCreateInput): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      this.database.prepare(`
        INSERT INTO tasks (
          id, prompt, model, configuration_revision_id, state, attempt, output, error
        ) VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL)
      `).run(
        input.id,
        input.prompt,
        input.model,
        input.configurationRevisionId,
        input.attempt,
      );
      this.insertEvent({
        taskId: input.id,
        type: 'task.queued',
        state: 'queued',
        configurationRevisionId: input.configurationRevisionId,
        attempt: input.attempt,
      });
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      if (String(cause).includes('UNIQUE')) {
        throw new TaskConflictError('Task id already exists.');
      }
      throw cause;
    }
    return this.getTask(input.id)!;
  }

  getTask(taskId: string): TaskSnapshot | null {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | TaskRow
      | undefined;
    return row ? toSnapshot(row) : null;
  }

  listTasks(): readonly TaskSnapshot[] {
    const rows = this.database.prepare('SELECT * FROM tasks ORDER BY id').all() as
      unknown as TaskRow[];
    return Object.freeze(rows.map(toSnapshot));
  }

  transitionTask(
    taskId: string,
    state: TaskState,
    event: TaskEventInput,
    patch: { readonly output?: string; readonly error?: string } = {},
  ): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const current = this.getTask(taskId);
      if (!current) throw new TaskNotFoundError();
      this.database.prepare(`
        UPDATE tasks SET state = ?, output = COALESCE(?, output), error = COALESCE(?, error)
        WHERE id = ?
      `).run(
        state,
        patch.output ?? null,
        patch.error ?? null,
        taskId,
      );
      this.insertEvent(event);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.getTask(taskId)!;
  }

  listEvents(afterEventId: string | null): readonly RuntimeEvent[] {
    let afterSequence = 0;
    if (afterEventId !== null) {
      const row = this.database.prepare('SELECT sequence FROM events WHERE id = ?')
        .get(afterEventId) as { sequence: number } | undefined;
      if (!row) throw new EventOrderError(`Unknown event cursor: ${afterEventId}`);
      afterSequence = row.sequence;
    }

    const rows = this.database.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence')
      .all(afterSequence) as unknown as EventRow[];
    return Object.freeze(rows.map(toEvent));
  }

  close(): void {
    this.database.close();
  }

  resetTask(taskId: string, attempt: number, event: TaskEventInput): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const current = this.getTask(taskId);
      if (!current) throw new TaskNotFoundError();
      this.database.prepare(`
        UPDATE tasks SET state = 'queued', attempt = ?, output = NULL, error = NULL
        WHERE id = ?
      `).run(attempt, taskId);
      this.insertEvent(event);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.getTask(taskId)!;
  }

  private insertEvent(input: TaskEventInput): void {
    const last = this.database.prepare('SELECT MAX(sequence) AS sequence FROM events')
      .get() as { sequence: number | null };
    const sequence = (last.sequence ?? 0) + 1;
    this.database.prepare(`
      INSERT INTO events (
        sequence, id, task_id, type, state, configuration_revision_id, attempt, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence,
      formatEventId(sequence),
      input.taskId,
      input.type,
      input.state,
      input.configurationRevisionId,
      input.attempt,
      JSON.stringify(input.data ?? {}),
    );
  }
}
