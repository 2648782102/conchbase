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
import {
  AgentConflictError,
  AgentNotFoundError,
  newAgentId,
  newAgentRevision,
  parseAgentProfile,
  type AgentDetail,
  type AgentId,
  type AgentProfileInput,
  type AgentRecord,
  type AgentRevision,
  type AgentRevisionId,
  type ModelReference,
} from './agent-profile.js';
import { SqliteWorkStore, type WorkStore } from './work-store.js';

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
  readonly agentId?: AgentId;
  readonly agentRevisionId?: AgentRevisionId;
  readonly providerId?: string;
  readonly modelId?: string;
}

export interface TaskCreateInput {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly attempt: number;
  readonly agentId?: AgentId;
  readonly agentRevisionId?: AgentRevisionId;
  readonly providerId?: string;
  readonly modelId?: string;
}

export interface AgentTaskCreateInput {
  readonly id: string;
  readonly prompt: string;
  readonly agentId: string;
  readonly expectedAgentRevisionId: string;
  readonly modelOverride?: ModelReference;
}

export interface TaskEventInput {
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly state: TaskState;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly attempt: number;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
  readonly agentId?: AgentId;
  readonly agentRevisionId?: AgentRevisionId;
  readonly providerId?: string;
  readonly modelId?: string;
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
  createAgentTask(input: AgentTaskCreateInput): TaskSnapshot;
  createAgent(profile: AgentProfileInput): AgentDetail;
  updateAgent(agentId: string, expectedRevisionId: string, profile: AgentProfileInput): AgentDetail;
  duplicateAgent(agentId: string, revisionId?: string, profile?: AgentProfileInput): AgentDetail;
  archiveAgent(agentId: string): AgentRecord;
  applyAgentRevision(agentId: string, revisionId: string, expectedRevisionId: string): AgentDetail;
  setDefaultAgent(agentId: string | null): string | null;
  listAgents(): readonly AgentRecord[];
  getAgent(agentId: string): AgentDetail | null;
  getAgentRevision(agentId: string, revisionId: string): AgentRevision | null;
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
  readonly work: WorkStore;
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
  readonly agent_id: string | null;
  readonly agent_revision_id: string | null;
  readonly provider_id: string | null;
  readonly model_id: string | null;
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
  readonly agent_id: string | null;
  readonly agent_revision_id: string | null;
  readonly provider_id: string | null;
  readonly model_id: string | null;
}

interface AgentRow {
  readonly id: string;
  readonly current_revision_id: string;
  readonly archived: number;
}

interface AgentRevisionRow {
  readonly id: string;
  readonly agent_id: string;
  readonly name: string;
  readonly instructions: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly created_at: string;
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
  return Object.freeze({
    id: row.id,
    prompt: row.prompt,
    model: row.model,
    configurationRevisionId: row.configuration_revision_id as ConfigurationRevisionId,
    state: row.state as TaskState,
    attempt: row.attempt,
    output: row.output,
    partialOutput: row.partial_output,
    error: row.error,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id as AgentId }),
    ...(row.agent_revision_id === null ? {} : { agentRevisionId: row.agent_revision_id as AgentRevisionId }),
    ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
  });
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
    ...(row.agent_id === null ? {} : { agentId: row.agent_id as AgentId }),
    ...(row.agent_revision_id === null ? {} : { agentRevisionId: row.agent_revision_id as AgentRevisionId }),
    ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
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

function toAgentRevision(row: AgentRevisionRow): AgentRevision {
  return Object.freeze({
    id: row.id as AgentRevisionId,
    name: row.name,
    instructions: row.instructions,
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
  });
}

export class SqliteTaskStore implements TaskStore {
  readonly work: WorkStore;
  private readonly database: DatabaseSync;
  private readonly clock: () => string;

  constructor(filename: string, options: { readonly clock?: () => string } = {}) {
    this.database = new DatabaseSync(filename);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.work = new SqliteWorkStore(this.database);
    try {
      this.database.exec('PRAGMA busy_timeout = 0;');
      this.database.exec('PRAGMA foreign_keys = ON;');
      this.database.exec('PRAGMA locking_mode = EXCLUSIVE;');
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.database.exec('BEGIN EXCLUSIVE;');
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
          error TEXT,
          agent_id TEXT,
          agent_revision_id TEXT,
          provider_id TEXT,
          model_id TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          type TEXT NOT NULL,
          state TEXT NOT NULL,
          configuration_revision_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          data TEXT NOT NULL,
          agent_id TEXT,
          agent_revision_id TEXT,
          provider_id TEXT,
          model_id TEXT
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
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          current_revision_id TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS agent_revisions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          name TEXT NOT NULL,
          instructions TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS agent_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          default_agent_id TEXT REFERENCES agents(id)
        ) STRICT;
      `);
      this.migrateAgentSchema();
      this.database.exec('INSERT OR IGNORE INTO agent_state (singleton, default_agent_id) VALUES (1, NULL)');
      this.database.exec('PRAGMA user_version = 2; COMMIT;');
      this.bootstrapConfiguration();
    } catch (cause) {
      try { this.database.exec('ROLLBACK;'); } catch { /* No migration transaction is open. */ }
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
          id, prompt, model, configuration_revision_id, state, attempt, output, partial_output, error,
          agent_id, agent_revision_id, provider_id, model_id
        ) VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(
        input.id,
        input.prompt,
        input.model,
        input.configurationRevisionId,
        input.attempt,
        input.agentId ?? null,
        input.agentRevisionId ?? null,
        input.providerId ?? null,
        input.modelId ?? null,
      );
      this.insertEvent({
        taskId: input.id,
        type: 'task.queued',
        state: 'queued',
        configurationRevisionId: input.configurationRevisionId,
        attempt: input.attempt,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
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

  createAgentTask(input: AgentTaskCreateInput): TaskSnapshot {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      const agent = this.getAgentRow(input.agentId);
      if (!agent) throw new AgentNotFoundError();
      if (agent.archived) throw new AgentConflictError('Archived Agents cannot start new tasks.');
      if (agent.current_revision_id !== input.expectedAgentRevisionId) {
        throw new AgentConflictError(`Agent revision changed; current revision is ${agent.current_revision_id}.`);
      }
      const profile = this.getAgentRevision(input.agentId, agent.current_revision_id);
      if (!profile) throw new AgentNotFoundError();
      const providerId = input.modelOverride?.providerId ?? profile.providerId;
      const modelId = input.modelOverride?.modelId ?? profile.modelId;
      const configuration = this.database.prepare(
        'SELECT revision_id FROM configuration_state WHERE singleton = 1',
      ).get() as ConfigurationActiveRow | undefined;
      if (!configuration) throw new Error('Configuration state is missing.');
      const agentId = input.agentId as AgentId;
      const agentRevisionId = profile.id;
      const configurationRevisionId = configuration.revision_id as ConfigurationRevisionId;
      this.database.prepare(`
        INSERT INTO tasks (
          id, prompt, model, configuration_revision_id, state, attempt,
          output, partial_output, error, agent_id, agent_revision_id, provider_id, model_id
        ) VALUES (?, ?, ?, ?, 'queued', 1, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(input.id, input.prompt, modelId, configurationRevisionId,
        agentId, agentRevisionId, providerId, modelId);
      this.insertEvent({
        taskId: input.id,
        type: 'task.queued',
        state: 'queued',
        configurationRevisionId,
        attempt: 1,
        agentId,
        agentRevisionId,
        providerId,
        modelId,
      });
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      if (String(cause).includes('UNIQUE')) throw new TaskConflictError('Task id already exists.');
      throw cause;
    }
    return this.getTask(input.id)!;
  }

  createAgent(input: AgentProfileInput): AgentDetail {
    const profile = parseAgentProfile(input);
    const id = newAgentId();
    const revision = newAgentRevision(profile, this.clock());
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('INSERT INTO agents (id, current_revision_id, archived) VALUES (?, ?, 0)')
        .run(id, revision.id);
      this.insertAgentRevision(id, revision);
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number };
      if (count.count === 1) {
        this.database.prepare('UPDATE agent_state SET default_agent_id = ? WHERE singleton = 1').run(id);
      }
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.getAgent(id)!;
  }

  updateAgent(agentId: string, expectedRevisionId: string, input: AgentProfileInput): AgentDetail {
    const profile = parseAgentProfile(input);
    const revision = newAgentRevision(profile, this.clock());
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const agent = this.getAgentRow(agentId);
      if (!agent) throw new AgentNotFoundError();
      if (agent.archived) throw new AgentConflictError('Archived Agents cannot be edited.');
      if (agent.current_revision_id !== expectedRevisionId) {
        throw new AgentConflictError(`Agent revision changed; current revision is ${agent.current_revision_id}.`);
      }
      this.insertAgentRevision(agentId, revision);
      this.database.prepare('UPDATE agents SET current_revision_id = ? WHERE id = ?').run(revision.id, agentId);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.getAgent(agentId)!;
  }

  duplicateAgent(agentId: string, revisionId?: string, input?: AgentProfileInput): AgentDetail {
    const source = this.getAgentRevision(agentId, revisionId ?? this.getAgentRow(agentId)?.current_revision_id ?? '');
    if (!source) throw new AgentNotFoundError();
    return this.createAgent(input ?? {
      name: `${source.name} copy`.slice(0, 120),
      instructions: source.instructions,
      providerId: source.providerId,
      modelId: source.modelId,
    });
  }

  archiveAgent(agentId: string): AgentRecord {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const agent = this.getAgentRow(agentId);
      if (!agent) throw new AgentNotFoundError();
      this.database.prepare('UPDATE agents SET archived = 1 WHERE id = ?').run(agentId);
      this.database.prepare(`
        UPDATE agent_state SET default_agent_id = NULL
        WHERE singleton = 1 AND default_agent_id = ?
      `).run(agentId);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.agentRecord(agentId)!;
  }

  applyAgentRevision(agentId: string, revisionId: string, expectedRevisionId: string): AgentDetail {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const agent = this.getAgentRow(agentId);
      if (!agent) throw new AgentNotFoundError();
      if (agent.archived) throw new AgentConflictError('Archived Agents cannot be changed.');
      if (agent.current_revision_id !== expectedRevisionId) {
        throw new AgentConflictError(`Agent revision changed; current revision is ${agent.current_revision_id}.`);
      }
      const historical = this.getAgentRevision(agentId, revisionId);
      if (!historical) throw new AgentNotFoundError();
      const revision = newAgentRevision({
        name: historical.name,
        instructions: historical.instructions,
        providerId: historical.providerId,
        modelId: historical.modelId,
      }, this.clock());
      this.insertAgentRevision(agentId, revision);
      this.database.prepare('UPDATE agents SET current_revision_id = ? WHERE id = ?')
        .run(revision.id, agentId);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return this.getAgent(agentId)!;
  }

  setDefaultAgent(agentId: string | null): string | null {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (agentId !== null) {
        const agent = this.getAgentRow(agentId);
        if (!agent) throw new AgentNotFoundError();
        if (agent.archived) throw new AgentConflictError('Archived Agents cannot be the default.');
      }
      this.database.prepare('UPDATE agent_state SET default_agent_id = ? WHERE singleton = 1').run(agentId);
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
    return agentId;
  }

  listAgents(): readonly AgentRecord[] {
    const rows = this.database.prepare('SELECT id FROM agents ORDER BY id').all() as unknown as { id: string }[];
    return Object.freeze(rows.map((row) => this.agentRecord(row.id)!).filter(Boolean));
  }

  getAgent(agentId: string): AgentDetail | null {
    const record = this.agentRecord(agentId);
    if (!record) return null;
    const rows = this.database.prepare(`
      SELECT id, agent_id, name, instructions, provider_id, model_id, created_at
      FROM agent_revisions WHERE agent_id = ? ORDER BY rowid DESC
    `).all(agentId) as unknown as AgentRevisionRow[];
    return Object.freeze({ ...record, revisions: Object.freeze(rows.map(toAgentRevision)) });
  }

  getAgentRevision(agentId: string, revisionId: string): AgentRevision | null {
    const row = this.database.prepare(`
      SELECT id, agent_id, name, instructions, provider_id, model_id, created_at
      FROM agent_revisions WHERE agent_id = ? AND id = ?
    `).get(agentId, revisionId) as AgentRevisionRow | undefined;
    return row ? toAgentRevision(row) : null;
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
        sequence, id, task_id, type, state, configuration_revision_id, attempt, data,
        agent_id, agent_revision_id, provider_id, model_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence,
      formatEventId(sequence),
      input.taskId,
      input.type,
      input.state,
      input.configurationRevisionId,
      input.attempt,
      JSON.stringify(input.data ?? {}),
      input.agentId ?? null,
      input.agentRevisionId ?? null,
      input.providerId ?? null,
      input.modelId ?? null,
    );
  }

  private migrateAgentSchema(): void {
    const versionRow = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (versionRow.user_version > 2) {
      throw new Error(`Database schema version ${versionRow.user_version} is newer than this runtime supports.`);
    }
    for (const [table, column] of [
      ['tasks', 'agent_id'],
      ['tasks', 'agent_revision_id'],
      ['tasks', 'provider_id'],
      ['tasks', 'model_id'],
      ['events', 'agent_id'],
      ['events', 'agent_revision_id'],
      ['events', 'provider_id'],
      ['events', 'model_id'],
    ] as const) {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
      if (!columns.some((item) => item.name === column)) {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS work_triggers (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        proposal_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_threads (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL UNIQUE,
        context_only INTEGER NOT NULL CHECK (context_only = 1),
        trigger_ids TEXT NOT NULL,
        work_item_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_mandates (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision = 1),
        scope TEXT NOT NULL,
        allowed_operations TEXT NOT NULL,
        capabilities_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state = 'open'),
        thread_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        mandate_revision INTEGER NOT NULL CHECK (mandate_revision = 1)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_assignments (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'planned'),
        agent_revision_id TEXT NOT NULL,
        configuration_revision_id TEXT NOT NULL,
        mandate_revision INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_outbox (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'pending'),
        destination_digest TEXT NOT NULL,
        payload_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_delivery_receipts (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        outbox_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'observed'),
        destination_digest TEXT NOT NULL,
        payload_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_events (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
    `);
  }

  private getAgentRow(agentId: string): AgentRow | null {
    const row = this.database.prepare('SELECT id, current_revision_id, archived FROM agents WHERE id = ?')
      .get(agentId) as AgentRow | undefined;
    return row ?? null;
  }

  private agentRecord(agentId: string): AgentRecord | null {
    const row = this.getAgentRow(agentId);
    if (!row) return null;
    const current = this.getAgentRevision(agentId, row.current_revision_id);
    if (!current) return null;
    const state = this.database.prepare('SELECT default_agent_id FROM agent_state WHERE singleton = 1')
      .get() as { default_agent_id: string | null } | undefined;
    return Object.freeze({
      id: row.id as AgentId,
      currentRevisionId: row.current_revision_id as AgentRevisionId,
      archived: row.archived === 1,
      isDefault: state?.default_agent_id === row.id,
      current,
    });
  }

  private insertAgentRevision(agentId: string, revision: AgentRevision): void {
    this.database.prepare(`
      INSERT INTO agent_revisions (id, agent_id, name, instructions, provider_id, model_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(revision.id, agentId, revision.name, revision.instructions,
      revision.providerId, revision.modelId, revision.createdAt);
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
