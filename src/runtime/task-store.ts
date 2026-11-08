import { DatabaseSync } from 'node:sqlite';
import {
  BOOTSTRAP_CONFIGURATION_DOCUMENT,
  configurationRevisionId,
  parseConfigurationDocument,
  revisionSummary,
  type ConfigurationDocument,
  type ConfigurationRevision,
  type ConfigurationRevisionId,
  type ConfigurationRevisionSummary,
} from './configuration-document.js';
import { EventOrderError, type RuntimeEvent } from './event-log.js';
import type { TaskEventType, TaskState } from './task-lifecycle.js';
import {
  ToolRequestConflictError,
  ToolRequestNotFoundError,
  type ToolRequestDecision,
  type ToolRequestRecord,
} from './tool-request.js';

export interface TaskSnapshot {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly state: TaskState;
  readonly attempt: number;
  readonly output: string | null;
  readonly partialOutput: string | null;
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

export interface ToolRequestCreateInput {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly compositionDocumentId: string;
  readonly compositionNodeId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly requestedEvent: TaskEventInput;
  readonly approvalRequiredEvent: TaskEventInput;
}

export interface ToolRequestCreateResult {
  readonly record: ToolRequestRecord;
  readonly created: boolean;
}

export interface ToolRequestDecisionInput {
  readonly approvalId: string;
  readonly decision: ToolRequestDecision;
  readonly reasonDigest: string;
  readonly decidedAt: string;
  readonly event: TaskEventInput;
}

export interface ToolRequestDecisionResult {
  readonly record: ToolRequestRecord;
  readonly changed: boolean;
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
  recordOutputDelta(taskId: string, event: TaskEventInput, partialOutput: string): TaskSnapshot;
  recordEvent(taskId: string, event: TaskEventInput): TaskSnapshot;
  createToolRequest(input: ToolRequestCreateInput): ToolRequestCreateResult;
  getToolRequest(requestId: string): ToolRequestRecord | null;
  decideToolRequest(requestId: string, input: ToolRequestDecisionInput): ToolRequestDecisionResult;
  listEvents(afterEventId: string | null): readonly RuntimeEvent[];
  getConfigurationState(): ConfigurationState;
  getConfigurationRevision(id: string): ConfigurationRevision | null;
  applyConfiguration(document: ConfigurationDocument): ApplyConfigurationResult;
  rollbackConfiguration(id: string): ApplyConfigurationResult;
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
  readonly partial_output: string | null;
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

interface ToolRequestRow {
  readonly id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly configuration_revision_id: string;
  readonly composition_document_id: string;
  readonly composition_node_id: string;
  readonly tool_name: string;
  readonly arguments_digest: string;
  readonly idempotency_key: string;
  readonly status: string;
  readonly created_at: string;
  readonly approval_id: string | null;
  readonly approval_decision: string | null;
  readonly approval_reason_digest: string | null;
  readonly approval_decided_at: string | null;
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

export class DatabaseInstanceError extends Error {
  constructor() {
    super('Runtime database is already owned by another Conchbase process or handle.');
    this.name = 'DatabaseInstanceError';
  }
}

export class ConfigurationRevisionNotFoundError extends Error {
  constructor() {
    super('Configuration revision not found.');
    this.name = 'ConfigurationRevisionNotFoundError';
  }
}

export { ToolRequestConflictError, ToolRequestNotFoundError };

export interface ConfigurationState {
  readonly active: ConfigurationRevision;
  readonly history: readonly ConfigurationRevisionSummary[];
}

export interface ApplyConfigurationResult {
  readonly state: ConfigurationState;
  readonly changed: boolean;
}

interface ConfigurationRevisionRow {
  readonly id: string;
  readonly document: string;
  readonly applied_at: string;
  readonly ordinal: number;
}

interface ConfigurationActiveRow {
  readonly revision_id: string;
}

function isDatabaseLocked(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { code?: unknown; errcode?: unknown; message?: unknown };
  return error.code === 'ERR_SQLITE_ERROR'
    && error.errcode === 5
    && typeof error.message === 'string'
    && error.message.toLowerCase().includes('database is locked');
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
    partialOutput: row.partial_output,
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

function toConfigurationRevision(row: ConfigurationRevisionRow): ConfigurationRevision {
  return Object.freeze({
    id: row.id as ConfigurationRevisionId,
    document: parseConfigurationDocument(JSON.parse(row.document) as unknown),
    appliedAt: row.applied_at,
  });
}

function toToolRequestRecord(row: ToolRequestRow): ToolRequestRecord {
  const approval = row.approval_id !== null
    && row.approval_decision !== null
    && row.approval_reason_digest !== null
    && row.approval_decided_at !== null
    ? Object.freeze({
      id: row.approval_id,
      decision: row.approval_decision as ToolRequestDecision,
      reasonDigest: row.approval_reason_digest,
      decidedAt: row.approval_decided_at,
    })
    : null;
  return Object.freeze({
    version: 1,
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    configurationRevisionId: row.configuration_revision_id,
    compositionDocumentId: row.composition_document_id as ToolRequestRecord['compositionDocumentId'],
    compositionNodeId: row.composition_node_id,
    toolName: row.tool_name,
    argumentsDigest: row.arguments_digest,
    idempotencyKey: row.idempotency_key,
    status: row.status as ToolRequestRecord['status'],
    createdAt: row.created_at,
    approval,
  });
}

export class SqliteTaskStore implements TaskStore {
  private readonly database: DatabaseSync;
  private readonly clock: () => string;

  constructor(filename: string, options: { readonly clock?: () => string } = {}) {
    this.database = new DatabaseSync(filename);
    this.clock = options.clock ?? (() => new Date().toISOString());
    try {
      this.database.exec('PRAGMA busy_timeout = 0;');
      this.database.exec('PRAGMA foreign_keys = ON;');
      this.database.exec('PRAGMA locking_mode = EXCLUSIVE;');
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.database.exec('BEGIN EXCLUSIVE; COMMIT;');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          model TEXT NOT NULL,
          configuration_revision_id TEXT NOT NULL,
          state TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          output TEXT,
          partial_output TEXT,
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
        CREATE TABLE IF NOT EXISTS configuration_revisions (
          id TEXT PRIMARY KEY,
          document TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          ordinal INTEGER NOT NULL UNIQUE
        ) STRICT;
        CREATE TABLE IF NOT EXISTS configuration_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision_id TEXT NOT NULL REFERENCES configuration_revisions(id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tool_requests (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          attempt INTEGER NOT NULL,
          configuration_revision_id TEXT NOT NULL,
          composition_document_id TEXT NOT NULL,
          composition_node_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          arguments_digest TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          approval_id TEXT,
          approval_decision TEXT,
          approval_reason_digest TEXT,
          approval_decided_at TEXT
        ) STRICT;
      `);
      this.bootstrapConfiguration();
    } catch (cause) {
      this.database.close();
      if (isDatabaseLocked(cause)) throw new DatabaseInstanceError();
      throw cause;
    }
  }

  createTask(input: TaskCreateInput): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      this.database.prepare(`
        INSERT INTO tasks (
          id, prompt, model, configuration_revision_id, state, attempt, output, partial_output, error
        ) VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL)
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
        UPDATE tasks SET state = ?, output = COALESCE(?, output),
          partial_output = CASE WHEN ? IN ('succeeded', 'failed', 'cancelled', 'interrupted')
            THEN NULL ELSE partial_output END,
          error = COALESCE(?, error)
        WHERE id = ?
      `).run(
        state,
        patch.output ?? null,
        state,
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

  getConfigurationState(): ConfigurationState {
    const row = this.database.prepare(
      'SELECT revision_id FROM configuration_state WHERE singleton = 1',
    ).get() as ConfigurationActiveRow | undefined;
    if (!row) throw new Error('Configuration state is missing.');
    const active = this.getConfigurationRevision(row.revision_id);
    if (!active) throw new Error('Active configuration revision is missing.');
    const revisions = this.database.prepare(
      'SELECT id, document, applied_at, ordinal FROM configuration_revisions ORDER BY ordinal DESC',
    ).all() as unknown as ConfigurationRevisionRow[];
    return Object.freeze({
      active,
      history: Object.freeze(revisions.map((revision) => revisionSummary(toConfigurationRevision(revision)))),
    });
  }

  getConfigurationRevision(id: string): ConfigurationRevision | null {
    if (!/^cfg_[0-9a-f]{24}$/.test(id)) return null;
    const row = this.database.prepare(
      'SELECT id, document, applied_at, ordinal FROM configuration_revisions WHERE id = ?',
    ).get(id) as ConfigurationRevisionRow | undefined;
    return row ? toConfigurationRevision(row) : null;
  }

  applyConfiguration(document: ConfigurationDocument): ApplyConfigurationResult {
    const id = configurationRevisionId(document);
    const current = this.getConfigurationState();
    if (current.active.id === id) return Object.freeze({ state: current, changed: false });
    this.runConfigurationTransaction(() => {
      this.insertConfigurationRevisionIfAbsent(document, id);
      this.database.prepare(
        'UPDATE configuration_state SET revision_id = ? WHERE singleton = 1',
      ).run(id);
    });
    return Object.freeze({ state: this.getConfigurationState(), changed: true });
  }

  rollbackConfiguration(id: string): ApplyConfigurationResult {
    if (!this.getConfigurationRevision(id)) throw new ConfigurationRevisionNotFoundError();
    const current = this.getConfigurationState();
    if (current.active.id === id) return Object.freeze({ state: current, changed: false });
    this.runConfigurationTransaction(() => {
      this.database.prepare(
        'UPDATE configuration_state SET revision_id = ? WHERE singleton = 1',
      ).run(id);
    });
    return Object.freeze({ state: this.getConfigurationState(), changed: true });
  }

  resetTask(taskId: string, attempt: number, event: TaskEventInput): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const current = this.getTask(taskId);
      if (!current) throw new TaskNotFoundError();
      this.database.prepare(`
        UPDATE tasks SET state = 'queued', attempt = ?, output = NULL, partial_output = NULL, error = NULL
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

  recordOutputDelta(
    taskId: string,
    event: TaskEventInput,
    partialOutput: string,
  ): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const current = this.getTask(taskId);
      if (!current) throw new TaskNotFoundError();
      this.database.prepare('UPDATE tasks SET partial_output = ? WHERE id = ?')
        .run(partialOutput, taskId);
      this.insertEvent(event);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.getTask(taskId)!;
  }

  recordEvent(taskId: string, event: TaskEventInput): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const current = this.getTask(taskId);
      if (!current) throw new TaskNotFoundError();
      this.insertEvent(event);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.getTask(taskId)!;
  }

  createToolRequest(input: ToolRequestCreateInput): ToolRequestCreateResult {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const existing = this.toolRequestByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        this.database.exec('COMMIT');
        return Object.freeze({ record: existing, created: false });
      }
      this.database.prepare(`
        INSERT INTO tool_requests (
          id, task_id, attempt, configuration_revision_id, composition_document_id,
          composition_node_id, tool_name, arguments_digest, idempotency_key,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        input.id,
        input.taskId,
        input.attempt,
        input.configurationRevisionId,
        input.compositionDocumentId,
        input.compositionNodeId,
        input.toolName,
        input.argumentsDigest,
        input.idempotencyKey,
        input.createdAt,
      );
      this.insertEvent(input.requestedEvent);
      this.insertEvent(input.approvalRequiredEvent);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return Object.freeze({ record: this.getToolRequest(input.id)!, created: true });
  }

  getToolRequest(requestId: string): ToolRequestRecord | null {
    const row = this.database.prepare('SELECT * FROM tool_requests WHERE id = ?')
      .get(requestId) as ToolRequestRow | undefined;
    return row ? toToolRequestRecord(row) : null;
  }

  decideToolRequest(requestId: string, input: ToolRequestDecisionInput): ToolRequestDecisionResult {
    let transactionOpen = true;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const row = this.database.prepare('SELECT * FROM tool_requests WHERE id = ?')
        .get(requestId) as ToolRequestRow | undefined;
      if (!row) {
        this.database.exec('COMMIT');
        transactionOpen = false;
        throw new ToolRequestNotFoundError();
      }
      if (row.status !== 'pending') {
        if (
          row.approval_decision === input.decision
          && row.approval_reason_digest === input.reasonDigest
        ) {
          this.database.exec('COMMIT');
          transactionOpen = false;
          return Object.freeze({ record: toToolRequestRecord(row), changed: false });
        }
        const conflict: ToolRequestConflictError = new ToolRequestConflictError(
          'Tool request already has a different decision.',
        );
        this.database.exec('COMMIT');
        transactionOpen = false;
        throw conflict;
      }
      this.database.prepare(`
        UPDATE tool_requests
        SET status = ?, approval_id = ?, approval_decision = ?,
            approval_reason_digest = ?, approval_decided_at = ?
        WHERE id = ?
      `).run(
        input.decision,
        input.approvalId,
        input.decision,
        input.reasonDigest,
        input.decidedAt,
        requestId,
      );
      this.insertEvent(input.event);
      this.database.exec('COMMIT');
      transactionOpen = false;
    } catch (cause) {
      if (transactionOpen) this.database.exec('ROLLBACK');
      throw cause;
    }
    return Object.freeze({ record: this.getToolRequest(requestId)!, changed: true });
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

  private toolRequestByIdempotencyKey(key: string): ToolRequestRecord | null {
    const row = this.database.prepare('SELECT * FROM tool_requests WHERE idempotency_key = ?')
      .get(key) as ToolRequestRow | undefined;
    return row ? toToolRequestRecord(row) : null;
  }

  private bootstrapConfiguration(): void {
    const active = this.database.prepare(
      'SELECT revision_id FROM configuration_state WHERE singleton = 1',
    ).get() as ConfigurationActiveRow | undefined;
    if (active) return;
    const document = parseConfigurationDocument(BOOTSTRAP_CONFIGURATION_DOCUMENT);
    const id = configurationRevisionId(document);
    this.runConfigurationTransaction(() => {
      this.insertConfigurationRevisionIfAbsent(document, id);
      this.database.prepare(
        'INSERT INTO configuration_state (singleton, revision_id) VALUES (1, ?)',
      ).run(id);
    });
  }

  private runConfigurationTransaction(action: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
  }

  private insertConfigurationRevisionIfAbsent(
    document: ConfigurationDocument,
    id: ConfigurationRevisionId,
  ): void {
    const existing = this.database.prepare(
      'SELECT id FROM configuration_revisions WHERE id = ?',
    ).get(id) as { id: string } | undefined;
    if (existing) return;
    const last = this.database.prepare(
      'SELECT MAX(ordinal) AS ordinal FROM configuration_revisions',
    ).get() as { ordinal: number | null };
    this.database.prepare(`
      INSERT INTO configuration_revisions (id, document, applied_at, ordinal)
      VALUES (?, ?, ?, ?)
    `).run(id, JSON.stringify(document), this.clock(), (last.ordinal ?? 0) + 1);
  }
}
