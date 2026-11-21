/**
 * Recurring Agent tasks.
 *
 * The Runtime could run a task when asked and could recover one after a crash,
 * but had no way to ask for one *later*. That is the difference between an
 * assistant you operate and one that reports on its own: "every morning, look at
 * yesterday's failures" needs a clock.
 *
 * Design choices, all of them deliberately small:
 *
 * - **A schedule is data.** It names an Agent, a prompt, and when to fire. It
 *   cannot grant a tool, widen a boundary, or change policy; the task it creates
 *   is pinned to the Agent's current revision exactly like a manual one.
 * - **No cron dialect.** An interval plus an optional "not before" is enough to
 *   express daily and hourly work, and it cannot be misread. Cron strings are a
 *   language, and a wrong parse here means a task firing at the wrong time.
 * - **Missed runs are not replayed.** A Runtime that was down for a day fires
 *   once on restart, not twenty-four times. Catching up would spend the user's
 *   tokens on stale work.
 * - **A firing that overlaps is skipped**, not queued. A schedule that takes
 *   longer than its interval should not build a backlog nobody asked for.
 */
import type { DatabaseSync } from 'node:sqlite';

export const SCHEDULE_CONTRACT_VERSION = 1;

/** The smallest interval worth supporting: anything shorter is a loop, not a schedule. */
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Schedule {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly intervalMs: number;
  readonly enabled: boolean;
  /** ISO timestamp of the last firing that produced a task, or null. */
  readonly lastRunAt: string | null;
  /** The task the most recent firing created, or null. */
  readonly lastTaskId: string | null;
  /** When this schedule may next fire. */
  readonly nextRunAt: string;
  readonly createdAt: string;
}

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

export interface ScheduleInput {
  readonly name: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly intervalMs: number;
  readonly enabled?: boolean;
  /** When the first firing is due. Defaults to one interval from now. */
  readonly startAt?: string;
}

export function parseScheduleInput(input: unknown, now: string): ScheduleInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ScheduleValidationError('Schedule must be an object.');
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(['name', 'agentId', 'prompt', 'intervalMs', 'enabled', 'startAt']);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ScheduleValidationError(`Unknown fields: ${unknown.sort().join(', ')}.`);

  const name = boundedString(record.name, 'name', 120);
  const agentId = boundedString(record.agentId, 'agentId', 200);
  const prompt = boundedString(record.prompt, 'prompt', 6_000);
  if (!Number.isInteger(record.intervalMs)) throw new ScheduleValidationError('intervalMs must be an integer.');
  const intervalMs = record.intervalMs as number;
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new ScheduleValidationError(`intervalMs must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}.`);
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new ScheduleValidationError('enabled must be a boolean.');
  }
  const startAt = record.startAt === undefined
    ? new Date(Date.parse(now) + intervalMs).toISOString()
    : parseInstant(record.startAt, 'startAt');
  return Object.freeze({
    name,
    agentId,
    prompt,
    intervalMs,
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    startAt,
  });
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ScheduleValidationError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function parseInstant(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ScheduleValidationError(`${label} must be an ISO timestamp.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ScheduleValidationError(`${label} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

/**
 * Whether a schedule is due.
 *
 * `nextRunAt` is authoritative rather than `lastRunAt + interval`: the stored
 * value already accounts for a skipped or delayed firing, so a clock that jumped
 * forward cannot make a schedule fire early.
 */
export function isDue(schedule: Schedule, nowIso: string): boolean {
  return schedule.enabled && Date.parse(schedule.nextRunAt) <= Date.parse(nowIso);
}

/**
 * The next firing after `nowIso`.
 *
 * Computed from the interval, not from the missed deadline, so a restart after
 * a long downtime produces one firing and then resumes the cadence rather than
 * a burst of back-dated runs.
 */
export function nextRunAfter(schedule: Pick<Schedule, 'intervalMs'>, nowIso: string): string {
  return new Date(Date.parse(nowIso) + schedule.intervalMs).toISOString();
}

export interface ScheduleStore {
  initialize(): void;
  list(): readonly Schedule[];
  get(id: string): Schedule | null;
  create(input: ScheduleInput, now: string): Schedule;
  update(id: string, patch: { readonly enabled?: boolean; readonly nextRunAt?: string; readonly lastRunAt?: string; readonly lastTaskId?: string }): Schedule;
  remove(id: string): boolean;
}

export function migrateScheduleSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      last_run_at TEXT,
      last_task_id TEXT,
      next_run_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
  `);
}

interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly agent_id: string;
  readonly prompt: string;
  readonly interval_ms: number;
  readonly enabled: number;
  readonly last_run_at: string | null;
  readonly last_task_id: string | null;
  readonly next_run_at: string;
  readonly created_at: string;
}

function toSchedule(row: ScheduleRow): Schedule {
  return Object.freeze({
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    prompt: row.prompt,
    intervalMs: row.interval_ms,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastTaskId: row.last_task_id,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  });
}

export class SqliteScheduleStore implements ScheduleStore {
  constructor(readonly database: DatabaseSync) {}

  initialize(): void {
    migrateScheduleSchema(this.database);
  }

  list(): readonly Schedule[] {
    const rows = this.database.prepare('SELECT * FROM schedules ORDER BY next_run_at').all() as unknown as ScheduleRow[];
    return Object.freeze(rows.map(toSchedule));
  }

  get(id: string): Schedule | null {
    const row = this.database.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as ScheduleRow | undefined;
    return row ? toSchedule(row) : null;
  }

  create(input: ScheduleInput, now: string): Schedule {
    const id = scheduleId(input.name, now);
    this.database.prepare(`
      INSERT INTO schedules (id, name, agent_id, prompt, interval_ms, enabled, last_run_at, last_task_id, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      id,
      input.name,
      input.agentId,
      input.prompt,
      input.intervalMs,
      input.enabled === false ? 0 : 1,
      input.startAt ?? now,
      now,
    );
    return this.get(id)!;
  }

  update(
    id: string,
    patch: { readonly enabled?: boolean; readonly nextRunAt?: string; readonly lastRunAt?: string; readonly lastTaskId?: string },
  ): Schedule {
    const current = this.get(id);
    if (!current) throw new ScheduleValidationError('Schedule not found.');
    this.database.prepare(`
      UPDATE schedules
      SET enabled = ?, next_run_at = ?, last_run_at = ?, last_task_id = ?
      WHERE id = ?
    `).run(
      (patch.enabled ?? current.enabled) ? 1 : 0,
      patch.nextRunAt ?? current.nextRunAt,
      patch.lastRunAt ?? current.lastRunAt,
      patch.lastTaskId ?? current.lastTaskId,
      id,
    );
    return this.get(id)!;
  }

  remove(id: string): boolean {
    return this.database.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }
}

function scheduleId(name: string, now: string): string {
  // Deterministic for a given name and moment, unique per creation: two
  // schedules with the same name created in the same millisecond are the same
  // request, and a client retrying gets the same id back.
  const seed = `${name}:${now}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `sch_${hash.toString(16).padStart(8, '0')}${seed.length.toString(16).padStart(4, '0')}`;
}
