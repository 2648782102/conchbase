import { createHash } from 'node:crypto';
import { containsSecretLike } from './secret-filter.js';

export const AGENT_MEMORY_VERSION = 1;

/**
 * Where a memory entry applies.
 *
 * Mirrors the scopes the product actually has: the whole Runtime, one project,
 * or one Agent. They are not interchangeable — recalling a project's detail as
 * a runtime-wide fact is how an assistant ends up confidently wrong about a
 * different project.
 */
export type MemoryScope = 'runtime' | 'project' | 'agent';

export const MEMORY_SCOPES: readonly MemoryScope[] = Object.freeze(['runtime', 'project', 'agent']);

export interface AgentMemoryEntry {
  readonly id: string;
  readonly scope: MemoryScope;
  /** Empty for runtime scope; the project or agent id otherwise. */
  readonly scopeId: string;
  /** Stable key used for deduplication, e.g. `project_summary:<projectId>`. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /**
   * Which turn produced this entry. Every memory must be traceable back to the
   * conversation that created it; a fact with no provenance cannot be audited
   * or meaningfully retracted.
   */
  readonly sourceIntentId: string;
  /**
   * `convergence` is Runtime-derived, `reviewer` means an independent review
   * Agent agreed, `proposal` means it was written without review.
   */
  readonly reviewedBy: MemoryReviewOutcome;
  readonly createdAt: string;
}

export interface AgentMemoryInput {
  readonly scope: MemoryScope;
  readonly scopeId?: string;
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly sourceIntentId?: string;
  readonly reviewedBy?: MemoryReviewOutcome;
}

/**
 * How an entry earned its place.
 *
 * `accepted` — an independent reviewer judged it a durable preference.
 * `unreviewed` — written by a Runtime-derivable path (project convergence).
 * `rejected` — a reviewer declined it; kept only as an audit record.
 */
export type MemoryReviewOutcome = 'accepted' | 'unreviewed';

export interface AgentMemoryStore {
  initialize(): void;
  /** Writes one entry, replacing an identical (scope, scopeId, key) entry. */
  write(input: AgentMemoryInput, now?: string): AgentMemoryEntry;
  list(options?: { readonly scope?: MemoryScope; readonly scopeId?: string; readonly limit?: number }): readonly AgentMemoryEntry[];
  get(id: string): AgentMemoryEntry | null;
  remove(id: string): boolean;
}

export const MEMORY_LIMITS = Object.freeze({
  title: 120,
  body: 2_000,
  key: 120,
  /** Entries injected into one prompt. */
  injected: 12,
  /** Entries retained per scope target. */
  perScope: 24,
});

export class AgentMemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentMemoryValidationError';
  }
}

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new AgentMemoryValidationError(`${label} must be a string.`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length === 0) throw new AgentMemoryValidationError(`${label} must not be empty.`);
  if (text.length > max) throw new AgentMemoryValidationError(`${label} must be at most ${max} characters.`);
  if (containsSecretLike(text)) throw new AgentMemoryValidationError(`${label} contains secret-like content.`);
  return text;
}

function memoryId(scope: MemoryScope, scopeId: string, key: string): string {
  return `mem_${createHash('sha256').update(`${scope}\u0000${scopeId}\u0000${key}`).digest('hex').slice(0, 24)}`;
}

/**
 * Validates one write.
 *
 * The scope determines whether a target id is required, and an unknown scope is
 * rejected rather than defaulted: silently widening a project fact into
 * runtime-wide memory would leak one project into every other conversation.
 */
export function parseAgentMemoryInput(value: unknown): AgentMemoryInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentMemoryValidationError('Memory input must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['scope', 'scopeId', 'key', 'title', 'body', 'sourceIntentId', 'reviewedBy']);
  const unknown = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new AgentMemoryValidationError(`Unknown memory fields: ${unknown.sort().join(', ')}.`);
  const scope = record.scope;
  if (typeof scope !== 'string' || !MEMORY_SCOPES.includes(scope as MemoryScope)) {
    throw new AgentMemoryValidationError('memory.scope must be runtime, project, or agent.');
  }
  const resolvedScope = scope as MemoryScope;
  const scopeId = resolvedScope === 'runtime'
    ? ''
    : bounded(record.scopeId, 'memory.scopeId', 200);
  return Object.freeze({
    scope: resolvedScope,
    ...(resolvedScope === 'runtime' ? {} : { scopeId }),
    key: bounded(record.key, 'memory.key', MEMORY_LIMITS.key),
    title: bounded(record.title, 'memory.title', MEMORY_LIMITS.title),
    body: bounded(record.body, 'memory.body', MEMORY_LIMITS.body),
    ...(record.sourceIntentId === undefined || record.sourceIntentId === ''
      ? {}
      : { sourceIntentId: bounded(record.sourceIntentId, 'memory.sourceIntentId', 200) }),
    reviewedBy: record.reviewedBy === 'accepted' ? 'accepted' as const : 'unreviewed' as const,
  });
}

export function agentMemoryId(input: AgentMemoryInput): string {
  return memoryId(input.scope, input.scopeId ?? '', input.key);
}

/**
 * Renders the compact index injected into a prompt.
 *
 * Only titles are included, newest-first, capped at `MEMORY_LIMITS.injected`.
 * Bodies stay out of the prompt: they are retrievable detail, and inlining them
 * is how a "small memory" quietly becomes the largest part of the context.
 */
export function renderMemoryIndex(entries: readonly AgentMemoryEntry[], limit = MEMORY_LIMITS.injected): string {
  if (entries.length === 0) return '';
  const bounded = entries.slice(0, Math.max(0, Math.min(limit, MEMORY_LIMITS.injected)));
  return bounded
    .map((entry) => {
      const scope = entry.scope === 'runtime' ? '全局' : entry.scope === 'project' ? `项目 ${entry.scopeId}` : `员工 ${entry.scopeId}`;
      return `- [${scope}] ${entry.title}`;
    })
    .join('\n');
}

export class InMemoryAgentMemoryStore implements AgentMemoryStore {
  private readonly entries = new Map<string, AgentMemoryEntry>();

  initialize(): void {}

  write(input: AgentMemoryInput, now = new Date().toISOString()): AgentMemoryEntry {
    const parsed = parseAgentMemoryInput(input);
    const id = agentMemoryId(parsed);
    const entry = Object.freeze({
      version: AGENT_MEMORY_VERSION,
      id,
      scope: parsed.scope,
      scopeId: parsed.scopeId ?? '',
      key: parsed.key,
      title: parsed.title,
      body: parsed.body,
      sourceIntentId: parsed.sourceIntentId ?? '',
      reviewedBy: parsed.reviewedBy ?? 'unreviewed',
      createdAt: now,
    });
    this.entries.set(id, entry);
    this.prune(parsed.scope, parsed.scopeId ?? '');
    return entry;
  }

  list(options: { readonly scope?: MemoryScope; readonly scopeId?: string; readonly limit?: number } = {}): readonly AgentMemoryEntry[] {
    const all = [...this.entries.values()]
      .filter((entry) => options.scope === undefined || entry.scope === options.scope)
      .filter((entry) => options.scopeId === undefined || entry.scopeId === options.scopeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return Object.freeze(options.limit === undefined ? all : all.slice(0, options.limit));
  }

  get(id: string): AgentMemoryEntry | null {
    return this.entries.get(id) ?? null;
  }

  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  private prune(scope: MemoryScope, scopeId: string): void {
    const same = [...this.entries.values()]
      .filter((entry) => entry.scope === scope && entry.scopeId === scopeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    for (const stale of same.slice(MEMORY_LIMITS.perScope)) this.entries.delete(stale.id);
  }
}

interface MemoryRow {
  readonly id: string;
  readonly scope: string;
  readonly scope_id: string;
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly source_intent_id: string;
  readonly reviewed_by: string;
  readonly created_at: string;
}

function fromRow(row: MemoryRow): AgentMemoryEntry {
  return Object.freeze({
    version: AGENT_MEMORY_VERSION,
    id: row.id,
    scope: row.scope as MemoryScope,
    scopeId: row.scope_id,
    key: row.key,
    title: row.title,
    body: row.body,
    sourceIntentId: row.source_intent_id,
    reviewedBy: row.reviewed_by === 'accepted' ? 'accepted' : 'unreviewed',
    createdAt: row.created_at,
  });
}

export class SqliteAgentMemoryStore implements AgentMemoryStore {
  constructor(private readonly database: import('node:sqlite').DatabaseSync) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('runtime', 'project', 'agent')),
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_intent_id TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT NOT NULL DEFAULT 'unreviewed',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_identity ON agent_memory (scope, scope_id, key);
      CREATE INDEX IF NOT EXISTS agent_memory_scope ON agent_memory (scope, scope_id, created_at DESC);
    `);
  }

  write(input: AgentMemoryInput, now = new Date().toISOString()): AgentMemoryEntry {
    const parsed = parseAgentMemoryInput(input);
    const id = agentMemoryId(parsed);
    const scopeId = parsed.scopeId ?? '';
    this.database.prepare(`
      INSERT INTO agent_memory (
        id, scope, scope_id, key, title, body, source_intent_id, reviewed_by, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_id, key) DO UPDATE SET
        title = excluded.title,
        body = excluded.body,
        source_intent_id = excluded.source_intent_id,
        reviewed_by = excluded.reviewed_by,
        created_at = excluded.created_at
    `).run(id, parsed.scope, scopeId, parsed.key, parsed.title, parsed.body,
      parsed.sourceIntentId ?? '', parsed.reviewedBy ?? 'unreviewed', now);
    this.prune(parsed.scope, scopeId);
    return Object.freeze({
      version: AGENT_MEMORY_VERSION,
      id,
      scope: parsed.scope,
      scopeId,
      key: parsed.key,
      title: parsed.title,
      body: parsed.body,
      sourceIntentId: parsed.sourceIntentId ?? '',
      reviewedBy: parsed.reviewedBy ?? 'unreviewed',
      createdAt: now,
    });
  }

  list(options: { readonly scope?: MemoryScope; readonly scopeId?: string; readonly limit?: number } = {}): readonly AgentMemoryEntry[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (options.scope !== undefined) {
      clauses.push('scope = ?');
      parameters.push(options.scope);
    }
    if (options.scopeId !== undefined) {
      clauses.push('scope_id = ?');
      parameters.push(options.scopeId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit === undefined
      ? -1
      : Math.max(1, Math.min(Math.trunc(options.limit), 500));
    const rows = this.database.prepare(`
      SELECT id, scope, scope_id, key, title, body, source_intent_id, reviewed_by, created_at
      FROM agent_memory
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, limit) as unknown as MemoryRow[];
    return Object.freeze(rows.map(fromRow));
  }

  get(id: string): AgentMemoryEntry | null {
    const row = this.database.prepare(`
      SELECT id, scope, scope_id, key, title, body, source_intent_id, reviewed_by, created_at
      FROM agent_memory WHERE id = ?
    `).get(id) as MemoryRow | undefined;
    return row ? fromRow(row) : null;
  }

  remove(id: string): boolean {
    const result = this.database.prepare('DELETE FROM agent_memory WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  private prune(scope: MemoryScope, scopeId: string): void {
    this.database.prepare(`
      DELETE FROM agent_memory
      WHERE scope = ? AND scope_id = ? AND id NOT IN (
        SELECT id FROM agent_memory
        WHERE scope = ? AND scope_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
    `).run(scope, scopeId, scope, scopeId, MEMORY_LIMITS.perScope);
  }
}
