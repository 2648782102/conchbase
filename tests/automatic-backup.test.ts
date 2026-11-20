import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { createAutomaticBackup } from '../src/runtime/automatic-backup.js';
import { inspectBackup } from '../src/runtime/backup.js';

/**
 * A backup nobody takes is not a backup.
 *
 * The Runtime already had `backup`, `verify-backup` and rotation, but all of it
 * needed the operator to remember. This takes the snapshot on a timer, keeps the
 * newest few, and never throws into the task loop.
 */

interface Fixture {
  readonly store: SqliteTaskStore;
  readonly directory: string;
  readonly backups: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-auto-backup-'));
  const backups = path.join(directory, 'backups');
  mkdirSync(backups, { recursive: true });
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  try {
    await run({ store, directory, backups });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function snapshots(directory: string): readonly string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.sqlite')).sort();
}

test('a run writes one readable snapshot and reports success', async () => {
  await withFixture(async ({ store, backups }) => {
    const automatic = createAutomaticBackup({ store, directory: backups, keep: 3 });
    try {
      await automatic.runOnce();
      const written = snapshots(backups);
      assert.equal(written.length, 1);
      assert.equal(automatic.status().lastOk, true);
      assert.ok(automatic.status().lastBackup !== null);
      // A file that merely exists is not a backup; it must open and pass
      // integrity. This is the same check `verify-backup` performs.
      const report = inspectBackup(path.join(backups, written[0]!));
      assert.equal(report.ok, true, `backup failed inspection: ${report.error ?? report.integrity}`);
    } finally {
      await automatic.stop();
    }
  });
});

test('rotation keeps only the newest snapshots', async () => {
  await withFixture(async ({ store, backups }) => {
    let tick = 0;
    const automatic = createAutomaticBackup({
      store,
      directory: backups,
      keep: 2,
      // Distinct filenames without waiting a real second between snapshots.
      clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    });
    try {
      for (let index = 0; index < 4; index += 1) await automatic.runOnce();
      assert.equal(snapshots(backups).length, 2, 'older snapshots are pruned');
    } finally {
      await automatic.stop();
    }
  });
});

test('a failing snapshot is reported instead of thrown', async () => {
  await withFixture(async ({ store, directory }) => {
    const automatic = createAutomaticBackup({
      store,
      directory: path.join(directory, 'does', 'not', 'exist'),
      keep: 2,
      snapshot: () => { throw new Error('disk full'); },
    });
    try {
      await assert.doesNotReject(() => automatic.runOnce());
      const status = automatic.status();
      assert.equal(status.lastOk, false);
      assert.match(status.lastError ?? '', /disk full/);
    } finally {
      await automatic.stop();
    }
  });
});

test('starting and stopping controls the timer without leaving work behind', async () => {
  await withFixture(async ({ store, backups }) => {
    const automatic = createAutomaticBackup({ store, directory: backups, keep: 2, intervalMs: 5_000 });
    automatic.start();
    await automatic.stop();
    assert.equal(snapshots(backups).length, 0, 'stopping before the first tick writes nothing');
    assert.equal(automatic.status().running, false);
  });
});
