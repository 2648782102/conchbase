/**
 * Database backup and inspection.
 *
 * `VACUUM INTO` writes a consistent snapshot of a live SQLite database without
 * copying a half-written file, which is what a plain `cp` would do. Inspection
 * reopens the copy read-only and reports what it contains.
 */
import { copyFileSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface BackupReport {
  readonly ok: boolean;
  readonly tables: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly integrity: string;
  readonly error?: string;
}

/** Writes a consistent snapshot using the already-open owner connection. */
export function backupOpenDatabase(database: DatabaseSync, target: string): void {
  if (existsSync(target)) throw new Error(`backup target already exists: ${target}`);
  database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/**
 * Backs up a database file by opening it read-write. This only works when no
 * other process owns the file; a running Runtime must call its own backup path.
 */
export function backupDatabase(source: string, target: string): void {
  if (!existsSync(source)) throw new Error(`source database does not exist: ${source}`);
  if (existsSync(target)) throw new Error(`backup target already exists: ${target}`);
  const database = new DatabaseSync(source);
  try {
    database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    database.close();
  }
}

/** Opens a backup read-only and reports its tables, row counts, and integrity. */
export function inspectBackup(file: string): BackupReport {
  if (!existsSync(file)) {
    return { ok: false, tables: [], counts: {}, integrity: 'missing', error: `backup not found: ${file}` };
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const tables = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as unknown as { name: string }[]).map((row) => row.name);
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
      counts[table] = Number(row.n);
    }
    const integrityRow = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    const integrity = integrityRow?.integrity_check ?? 'unknown';
    if (integrity !== 'ok') {
      return { ok: false, tables, counts, integrity, error: `integrity check failed: ${integrity}` };
    }
    return { ok: true, tables, counts, integrity };
  } catch (cause) {
    return {
      ok: false,
      tables: [],
      counts: {},
      integrity: 'unreadable',
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    database?.close();
  }
}

export function formatBackupReport(report: BackupReport): string {
  if (!report.ok) return `backup check FAILED: ${report.error ?? 'unknown error'}\n`;
  const rows = report.tables.map((table) => `  ${table.padEnd(28)} ${report.counts[table] ?? 0}`);
  return [
    `backup check ok (integrity: ${report.integrity})`,
    ...rows,
  ].join('\n') + '\n';
}

/**
 * Keeps the newest `keep` backups in a directory and deletes older ones.
 * Names are expected to sort chronologically (e.g. `runtime-2026-11-19T…`).
 */
export function rotateBackups(directory: string, keep: number): {
  readonly kept: readonly string[];
  readonly removed: readonly string[];
} {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer.');
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sqlite'))
    .sort()
    .reverse();
  const kept = files.slice(0, keep);
  const removed = files.slice(keep);
  for (const name of removed) unlinkSync(`${directory}/${name}`);
  return { kept, removed };
}

/** A timestamped backup filename, safe on every supported platform. */
export function backupFileName(stamp: string): string {
  return `runtime-${stamp.replace(/[:.]/g, '-')}.sqlite`;
}

export interface RestoreReport {
  readonly restored: boolean;
  /** Where the previous live database was moved, or null when there was none. */
  readonly movedPreviousTo: string | null;
  readonly report: BackupReport;
}

/**
 * Replaces a live database with a snapshot, after proving the snapshot is one.
 *
 * The documented rollback used to be `cp backup live`, which has two failure
 * modes that matter at the worst possible moment: it overwrites the current
 * database before anyone has checked the backup is readable, and a `cp` killed
 * halfway leaves a truncated file that only fails on the next start. This
 * validates first, then moves the live file aside instead of destroying it, and
 * finally renames the copy into place — a rename within one directory is atomic,
 * so the live path is either the old file or the restored one, never a partial.
 *
 * It refuses to run while a Runtime owns the database, because that owner holds
 * the only connection and would keep writing to the replaced inode.
 */
export function restoreBackup(source: string, target: string): RestoreReport {
  const report = inspectBackup(source);
  if (!report.ok) {
    throw new Error(`refusing to restore from an unreadable backup: ${report.error ?? 'unknown error'}`);
  }
  const staged = `${target}.restoring`;
  copyFileSync(source, staged);
  const stagedReport = inspectBackup(staged);
  if (!stagedReport.ok) {
    unlinkSync(staged);
    throw new Error(`restored copy failed verification: ${stagedReport.error ?? 'unknown error'}`);
  }
  const previous = existsSync(target) ? `${target}.before-restore-${Date.now()}` : null;
  if (previous) renameSync(target, previous);
  renameSync(staged, target);
  return { restored: true, movedPreviousTo: previous, report: stagedReport };
}
