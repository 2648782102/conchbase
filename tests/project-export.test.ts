import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { parseOrganizationAction } from '../src/runtime/organization-contract.js';
import { buildProjectExport, exportProjectToFile } from '../src/runtime/project-export.js';

function store(): InMemoryOrganizationStore {
  const s = new InMemoryOrganizationStore();
  s.apply(parseOrganizationAction({ type: 'open_project', expectedSequence: s.get().events.length, projectId: 'p1', originTriggerId: 't1' }));
  s.apply(parseOrganizationAction({ type: 'activate_project', expectedSequence: s.get().events.length, projectId: 'p1' }));
  return s;
}

test('an export contains state, next action, and a readable summary', () => {
  const doc = buildProjectExport(store().get(), 'p1', { now: '2026-11-19T00:00:00.000Z' });
  assert.equal(doc?.version, 1);
  assert.equal(doc?.state, 'active');
  assert.ok((doc?.nextAction ?? '').length > 0);
  assert.equal(doc?.exportedAt, '2026-11-19T00:00:00.000Z');
  assert.ok(typeof doc?.summary === 'string');
});

test('exporting a known project writes valid JSON to disk', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-export-'));
  const target = path.join(directory, 'p1.json');
  try {
    exportProjectToFile(store().get(), 'p1', target);
    assert.equal(existsSync(target), true);
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(parsed.projectId, 'p1');
    assert.equal(parsed.workers.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('exporting refuses to overwrite and rejects an unknown project', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-export-'));
  const target = path.join(directory, 'p1.json');
  try {
    exportProjectToFile(store().get(), 'p1', target);
    assert.throws(() => exportProjectToFile(store().get(), 'p1', target));
    assert.equal(buildProjectExport(store().get(), 'missing'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
