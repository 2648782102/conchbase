import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryOrganizationStore,
  ORGANIZATION_STORE_CONTRACT_VERSION,
} from '../src/runtime/organization-store.js';
import { OrganizationValidationError } from '../src/runtime/organization-contract.js';

function bootstrap(): InMemoryOrganizationStore {
  const store = new InMemoryOrganizationStore();
  store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_alpha', originTriggerId: 'trigger_one' });
  store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_alpha' });
  return store;
}

test('organization store keeps one snapshot and advances sequences', () => {
  const store = bootstrap();
  const snapshot = store.get();
  assert.equal(snapshot.version, ORGANIZATION_STORE_CONTRACT_VERSION);
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.projects[0]?.state, 'active');

  const next = store.apply({
    type: 'create_agent',
    expectedSequence: 2,
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    delegationId: 'delegation_alpha',
    agentRevisionId: 'agent_revision_alpha',
    displayName: 'Worker',
    instructionsDigest: 'sha256_instructions',
    scope: ['project:alpha'],
    capabilities: ['cap_read_context'],
    model: { providerId: 'local', modelId: 'test-model' },
    maxDelegationDepth: 0,
    ttlEvents: 20,
  });
  assert.equal(next.events.length, 3);
  assert.equal(store.get().events.length, 3);
});

test('organization store returns bounded event slices', () => {
  const store = bootstrap();
  assert.equal(store.events().length, 2);
  assert.equal(store.events(1).length, 1);
  assert.equal(store.events(1)[0]?.type, 'organization.project_activated');
  assert.throws(() => store.events(0), OrganizationValidationError);
  assert.throws(() => store.events(1001), OrganizationValidationError);
});

test('organization store can reinitialize a primary conversation', () => {
  const store = bootstrap();
  const fresh = store.initialize('conversation_second');
  assert.equal(fresh.events.length, 0);
  assert.equal(fresh.bossSession.id, store.get().bossSession.id);
});
