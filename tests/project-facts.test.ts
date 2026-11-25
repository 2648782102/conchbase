import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_FACT_LIMITS,
  promoteProjectFact,
  projectFactsFor,
  upsertProjectFact,
} from '../src/runtime/project-facts.js';

const now = () => '2026-11-25T00:00:00.000Z';

test('promoteProjectFact bounds and validates untrusted report text', () => {
  assert.deepEqual(promoteProjectFact({ projectId: 'p1', key: '  summary  ', body: '  done  ', now }), {
    id: 'pf_p1:summary', projectId: 'p1', key: 'summary', body: 'done',
    sourceReportId: null, createdAt: now(), updatedAt: now(),
  });
  assert.equal(promoteProjectFact({ projectId: 'p1', key: '', body: 'x', now }), null);
  assert.equal(promoteProjectFact({ projectId: 'p1', key: 'k', body: 'token sk-123', now }), null);
  const large = promoteProjectFact({ projectId: 'p1', key: 'k', body: 'x'.repeat(5000), now });
  assert.equal(large?.body.length, PROJECT_FACT_LIMITS.bodyChars);
});

test('upsertProjectFact updates the same key without duplicating it', () => {
  const first = promoteProjectFact({ projectId: 'p1', key: 'status', body: 'old', now })!;
  const second = promoteProjectFact({ projectId: 'p1', key: 'status', body: 'new', now })!;
  const facts = upsertProjectFact(upsertProjectFact([], first), second);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.body, 'new');
  assert.equal(facts[0]?.createdAt, now());
});

test('projectFactsFor returns only active project facts within the bound', () => {
  const facts = Array.from({ length: 30 }, (_, index) =>
    promoteProjectFact({ projectId: index < 20 ? 'p1' : 'p2', key: `k${index}`, body: `v${index}`, now })!);
  const reduced = projectFactsFor(facts, ['p1']);
  assert.equal(reduced.length, 20);
  assert.ok(reduced.every((fact) => fact.projectId === 'p1'));
});
