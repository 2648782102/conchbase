import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema creation and migration.
 *
 * Split from the store so the shape of the database can be read without the
 * 60 query methods around it. This does not change ownership: the store still
 * constructs the one `DatabaseSync` and passes it in, and this module performs
 * no queries other than DDL and the version check.
 *
 * Migrations are additive and idempotent. A caller that opens an older file
 * gets the missing columns and tables; a caller that opens a newer file is
 * refused rather than silently degraded.
 */

export function migrateAgentSchema(database: DatabaseSync): void {
    const versionRow = database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (versionRow.user_version > 9) {
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
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
      if (!columns.some((item) => item.name === column)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    }
    const revisionColumns = database.prepare('PRAGMA table_info(agent_revisions)')
      .all() as unknown as { name: string }[];
    if (revisionColumns.length > 0 && !revisionColumns.some((item) => item.name === 'granted_capabilities')) {
      database.exec("ALTER TABLE agent_revisions ADD COLUMN granted_capabilities TEXT NOT NULL DEFAULT '[]'");
    }
    database.exec(
      'CREATE INDEX IF NOT EXISTS events_task_sequence ON events (task_id, sequence)',
    );
    // Idempotent-write checks scan only this task's executed-tool events instead
    // of the whole log; output deltas dominate the table and are excluded by the
    // partial predicate.
    database.exec(`
      CREATE INDEX IF NOT EXISTS events_tool_executed
      ON events (task_id) WHERE type = 'agent_loop.tool_executed'
    `);
    database.exec(`
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
        state TEXT NOT NULL CHECK (state IN ('open', 'running', 'paused', 'completed', 'cancelled')),
        thread_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        mandate_revision INTEGER NOT NULL CHECK (mandate_revision = 1)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_assignments (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'interrupted', 'succeeded', 'failed', 'cancelled')),
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
        destination_digest TEXT NOT NULL,
        payload_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_delivery_receipts (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        outbox_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('observed', 'accepted', 'rejected')),
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

