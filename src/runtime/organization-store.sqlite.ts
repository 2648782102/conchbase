import type { DatabaseSync } from 'node:sqlite';
import {
  ORGANIZATION_CONTRACT_VERSION,
  OrganizationConflictError,
  OrganizationValidationError,
  applyOrganizationAction,
  createOrganization,
  parseOrganizationAction,
  type OrganizationAction,
  type OrganizationEvent,
  type OrganizationSnapshot,
} from './organization-contract.js';
import {
  ORGANIZATION_STORE_CONTRACT_VERSION,
  parseOrganizationLimit,
  type OrganizationStore,
} from './organization-store.js';

interface OrganizationStateRow {
  readonly singleton: number;
  readonly conversation_id: string;
}

interface OrganizationActionRow {
  readonly sequence: number;
  readonly action: string;
}

const MAX_PERSISTED_ACTION_LENGTH = 8192;

function replay(database: DatabaseSync, conversationId: string): OrganizationSnapshot {
  let snapshot = createOrganization(conversationId);
  const rows = database.prepare('SELECT sequence, action FROM organization_actions ORDER BY sequence')
    .all() as unknown as OrganizationActionRow[];
  rows.forEach((row, index) => {
    if (row.sequence !== index + 1) {
      throw new OrganizationConflictError('Organization action sequence is not contiguous.');
    }
    if (typeof row.action !== 'string' || row.action.length > MAX_PERSISTED_ACTION_LENGTH) {
      throw new OrganizationConflictError('Persisted organization action is invalid.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.action);
    } catch {
      throw new OrganizationConflictError('Persisted organization action is not valid JSON.');
    }
    snapshot = applyOrganizationAction(snapshot, parsed);
  });
  return snapshot;
}

export class SqliteOrganizationStore implements OrganizationStore {
  constructor(private readonly database: DatabaseSync, private readonly inTransaction: () => boolean = () => false) {}

  initialize(conversationId: string): OrganizationSnapshot {
    const trimmed = conversationId.trim();
    if (trimmed.length === 0 || trimmed.length > 240) {
      throw new OrganizationValidationError('Conversation id must be a bounded non-empty string.');
    }
    const existing = this.database.prepare('SELECT singleton, conversation_id FROM organization_state WHERE singleton = 1')
      .get() as OrganizationStateRow | undefined;
    if (existing) return this.get();
    this.database.prepare('INSERT OR IGNORE INTO organization_state (singleton, conversation_id) VALUES (1, ?)')
      .run(trimmed);
    return replay(this.database, trimmed);
  }

  get(): OrganizationSnapshot {
    const row = this.database.prepare('SELECT singleton, conversation_id FROM organization_state WHERE singleton = 1')
      .get() as OrganizationStateRow | undefined;
    if (!row) throw new OrganizationConflictError('Organization state is not initialized.');
    return replay(this.database, row.conversation_id);
  }

  apply(input: unknown): OrganizationSnapshot {
    const action = parseOrganizationAction(input);
    if (JSON.stringify(action).length > MAX_PERSISTED_ACTION_LENGTH) {
      throw new OrganizationValidationError('Organization action is too large to persist.');
    }
    const snapshot = this.get();
    const next = applyOrganizationAction(snapshot, action);
    const event = next.events.at(-1);
    if (!event) throw new Error('Organization action did not produce an event.');
    const ownsTransaction = !this.inTransaction();
    if (ownsTransaction) this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('INSERT INTO organization_actions (sequence, action) VALUES (?, ?)')
        .run(event.sequence, JSON.stringify(action));
      if (ownsTransaction) this.database.exec('COMMIT');
    } catch (cause) {
      if (ownsTransaction) this.database.exec('ROLLBACK');
      throw cause;
    }
    return next;
  }

  events(limit?: number): readonly OrganizationEvent[] {
    const bounded = parseOrganizationLimit(limit);
    return Object.freeze(this.get().events.slice(-bounded));
  }
}

export function migrateOrganizationSchema(database: DatabaseSync): void {
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 5) throw new Error(`Database schema version ${version} is newer than this runtime supports.`);
  if (version < 4) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS organization_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        conversation_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS organization_actions (
        sequence INTEGER PRIMARY KEY,
        action TEXT NOT NULL
      ) STRICT;
    `);
  }
}

export const SQLITE_ORGANIZATION_STORE_CONTRACT_VERSION = ORGANIZATION_STORE_CONTRACT_VERSION;
export const SQLITE_ORGANIZATION_CONTRACT_VERSION = ORGANIZATION_CONTRACT_VERSION;
