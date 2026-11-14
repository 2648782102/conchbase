import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ORGANIZATION_AGENT_PROJECTION_VERSION,
  projectDynamicAgentProposal,
} from '../src/runtime/organization-agent-projection.js';
import { OrganizationValidationError } from '../src/runtime/organization-contract.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function action(overrides: Record<string, unknown> = {}) {
  return {
    type: 'create_agent',
    expectedSequence: 0,
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    delegationId: 'delegation_alpha',
    agentRevisionId: 'agent_revision_alpha',
    displayName: 'Project Worker',
    instructionsDigest: 'sha256_instructions',
    scope: ['project:alpha'],
    capabilities: ['cap_read_context'],
    model: { providerId: 'local', modelId: 'test-model' },
    maxDelegationDepth: 1,
    ttlEvents: 50,
    ...overrides,
  };
}

test('dynamic agent projection is stable, bounded, and digest-only', () => {
  const first = projectDynamicAgentProposal(action());
  const second = projectDynamicAgentProposal(action());
  assert.equal(first.version, ORGANIZATION_AGENT_PROJECTION_VERSION);
  assert.equal(first.id, second.id);
  assert.equal(first.instructionsDigest, 'sha256_instructions');
  assert.deepEqual(first.model, { providerId: 'local', modelId: 'test-model' });
  assert.equal(first.parentDelegationId, null);
  assert.doesNotMatch(JSON.stringify(first), /"instructions":/);
  assert.doesNotMatch(JSON.stringify(first), /sk-|Bearer|password|apiKey/);
});

test('dynamic agent projection rejects secret-like and non-organization actions', () => {
  assert.throws(
    () => projectDynamicAgentProposal(action({ displayName: 'sk-leak' })),
    OrganizationValidationError,
  );
  assert.throws(
    () => projectDynamicAgentProposal(action({ displayName: '../outside' })),
    OrganizationValidationError,
  );
  assert.throws(
    () => projectDynamicAgentProposal({
      type: 'open_project', expectedSequence: 0,
      projectId: 'project_alpha', originTriggerId: 'trigger_one',
    }),
    OrganizationValidationError,
  );
});

test('dynamic agent projection does not add public routes or store writes', () => {
  const source = readFileSync(
    path.join(repositoryRoot, 'src/runtime/organization-agent-projection.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /SqliteTaskStore|createAgent\(|database|fetch\(|exec\(/);
  const spec = readFileSync(path.join(repositoryRoot, 'docs/openapi.yaml'), 'utf8');
  assert.equal([...spec.matchAll(/^  (\/v1\/[^:]+):$/gm)].length, 89);
  assert.doesNotMatch(source, /\/v1\/organization/);
});
