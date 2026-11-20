import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseInstanceError, SqliteTaskStore } from '../src/runtime/task-store.js';

/**
 * One database, one owner.
 *
 * This is a product constraint, not an accident of SQLite: the Runtime keeps
 * live state in memory (abort controllers, admission slots, the conversation
 * turn queue) that a second process would not share. The failure has to be
 * loud and actionable, because the alternative — two processes each believing
 * they are the sole writer — is exactly the class of bug this project has spent
 * several rounds removing.
 */
test('a second owner of the same database fails with an actionable message', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-single-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const first = new SqliteTaskStore(filename);
  try {
    assert.throws(
      () => new SqliteTaskStore(filename),
      (cause: unknown) => {
        assert.ok(cause instanceof DatabaseInstanceError);
        const message = (cause as Error).message;
        // Names the constraint, the likely cause, and two concrete ways out.
        assert.match(message, /single-process/i);
        assert.match(message, /conchbase status/);
        assert.match(message, /CONCHBASE_DB/);
        return true;
      },
    );
  } finally {
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the database is usable again once the first owner closes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-single-reopen-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const first = new SqliteTaskStore(filename);
  first.close();
  const second = new SqliteTaskStore(filename);
  try {
    assert.equal(second.listTasks().length, 0);
  } finally {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
