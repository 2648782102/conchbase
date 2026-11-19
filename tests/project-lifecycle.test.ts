import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { projectLifecycleView } from '../src/runtime/project-lifecycle-view.js';
import { parseOrganizationAction } from '../src/runtime/organization-contract.js';

function store(): InMemoryOrganizationStore {
  const s = new InMemoryOrganizationStore();
  const seq = () => s.get().events.length;
  s.apply(parseOrganizationAction({ type: 'open_project', expectedSequence: seq(), projectId: 'p1', originTriggerId: 't1' }));
  return s;
}

test('a forming project offers a clear next step', () => {
  const view = projectLifecycleView(store().get(), 'p1');
  assert.equal(view?.state, 'forming');
  assert.match(view?.nextAction ?? '', /启动/);
});

test('an active project with no attention tells the user to wait or add detail', () => {
  const s = store();
  s.apply(parseOrganizationAction({ type: 'activate_project', expectedSequence: s.get().events.length, projectId: 'p1' }));
  const view = projectLifecycleView(s.get(), 'p1');
  assert.equal(view?.state, 'active');
  assert.match(view?.nextAction ?? '', /等待|补充/);
});

test('an archived project says how to resume', () => {
  const s = store();
  s.apply(parseOrganizationAction({ type: 'activate_project', expectedSequence: s.get().events.length, projectId: 'p1' }));
  s.apply(parseOrganizationAction({ type: 'archive_project', expectedSequence: s.get().events.length, projectId: 'p1' }));
  const view = projectLifecycleView(s.get(), 'p1');
  assert.equal(view?.state, 'archived');
  assert.match(view?.nextAction ?? '', /恢复/);
});

test('an unknown project yields null rather than a fake view', () => {
  assert.equal(projectLifecycleView(store().get(), 'nope'), null);
});
