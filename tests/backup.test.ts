import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';
import { backupDatabase, backupOpenDatabase, inspectBackup, restoreBackup } from '../src/runtime/backup.js';

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}
function okFetch(): typeof globalThis.fetch {
  return (async () => new Response(sse('done'), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch;
}

test('a backup is a consistent snapshot that can be inspected independently', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-backup-'));
  const source = path.join(directory, 'runtime.sqlite');
  const target = path.join(directory, 'snapshot.sqlite');
  const service = createTaskService(source, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch() });
  try {
    const task = service.createTask({ prompt: 'hello' });
    service.startTask(task.id);
    await service.waitForTask(task.id);

    service.store.backupTo(target);
    assert.equal(existsSync(target), true);
    assert.ok(statSync(target).size > 0);

    const report = inspectBackup(target);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.ok(report.tables.includes('tasks'));
    assert.ok(report.tables.includes('events'));
    assert.ok((report.counts.tasks ?? 0) >= 1);
    assert.ok((report.counts.events ?? 0) >= 1);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backing up onto an existing path is refused rather than overwriting', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-backup-'));
  const source = path.join(directory, 'runtime.sqlite');
  const target = path.join(directory, 'existing.sqlite');
  const service = createTaskService(source, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch() });
  try {
    service.createTask({ prompt: 'x' });
    service.store.backupTo(target);
    assert.throws(() => backupDatabase(source, target), /exists|already/i);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inspecting a non-database file fails with a readable error', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-backup-'));
  const bogus = path.join(directory, 'not.db');
  try {
    writeFileSync(bogus, 'not a database');
    const report = inspectBackup(bogus);
    assert.equal(report.ok, false);
    assert.ok(report.error && report.error.length > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rotation keeps the newest N backups and removes the rest', async () => {
  const { rotateBackups, backupFileName } = await import('../src/runtime/backup.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-rotate-'));
  try {
    for (const stamp of ['2026-11-17T00:00:00.000Z', '2026-11-18T00:00:00.000Z', '2026-11-19T00:00:00.000Z']) {
      writeFileSync(path.join(directory, backupFileName(stamp)), 'x');
    }
    const result = rotateBackups(directory, 2);
    assert.equal(result.kept.length, 2);
    assert.equal(result.removed.length, 1);
    assert.match(result.removed[0] ?? '', /2026-11-17/);
    assert.throws(() => rotateBackups(directory, 0));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup file names are portable and sorted by time', async () => {
  const { backupFileName } = await import('../src/runtime/backup.js');
  const a = backupFileName('2026-11-18T10:00:00.000Z');
  const b = backupFileName('2026-11-19T10:00:00.000Z');
  assert.equal(a.includes(':'), false, 'no colon for Windows compatibility');
  assert.ok(a < b);
});

test('a pre-upgrade snapshot opens cleanly with the current store', async () => {
  const { SqliteTaskStore } = await import('../src/runtime/task-store.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-upgrade-'));
  const live = path.join(directory, 'runtime.sqlite');
  const snapshot = path.join(directory, 'before.sqlite');
  const service = createTaskService(live, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch() });
  try {
    const task = service.createTask({ prompt: 'x' });
    service.startTask(task.id);
    await service.waitForTask(task.id);
    service.store.backupTo(snapshot);
  } finally {
    service.close();
  }
  const restored = new SqliteTaskStore(snapshot);
  try {
    assert.equal(restored.listTasks().length >= 1, true, 'the snapshot is a usable database');
  } finally {
    restored.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Restoring is the one operation that can destroy the live database.
 *
 * The documented rollback was `cp snapshot live`. Two failures follow from
 * that: the copy is written over a database nobody has checked is readable,
 * and a `cp` interrupted halfway leaves a file that only fails on the next
 * start. Restore therefore validates the source, stages the copy, validates
 * the stage, and moves the previous database aside rather than deleting it.
 */
test('a restore replaces the live database and keeps the previous one', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-restore-'));
  const live = path.join(directory, 'runtime.sqlite');
  const snapshot = path.join(directory, 'snapshot.sqlite');
  const service = createTaskService(live, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch() });
  try {
    const kept = service.createTask({ prompt: '在快照里' });
    service.startTask(kept.id);
    await service.waitForTask(kept.id);
    service.store.backupTo(snapshot);
    // Work created after the snapshot must disappear on restore, otherwise the
    // test would pass on a no-op.
    service.createTask({ prompt: '快照之后' });
  } finally {
    service.close();
  }

  const result = restoreBackup(snapshot, live);
  assert.equal(result.restored, true);
  assert.ok(result.movedPreviousTo && existsSync(result.movedPreviousTo), 'the previous database is kept, not deleted');
  assert.equal(result.report.ok, true);

  const restoredService = createTaskService(live, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch() });
  try {
    const prompts = restoredService.store.listTasks().map((task) => task.prompt);
    assert.deepEqual(prompts, ['在快照里'], 'the restored database is the snapshot, not the newer state');
  } finally {
    restoredService.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restore refuses an unreadable snapshot and leaves the live database untouched', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-restore-bad-'));
  const live = path.join(directory, 'runtime.sqlite');
  const bogus = path.join(directory, 'bogus.sqlite');
  try {
    writeFileSync(live, 'live bytes that must survive');
    writeFileSync(bogus, 'not a database');
    assert.throws(() => restoreBackup(bogus, live), /unreadable backup/);
    assert.equal(readFileSync(live, 'utf8'), 'live bytes that must survive');
    assert.equal(existsSync(`${live}.restoring`), false, 'a refused restore leaves no staged file behind');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
