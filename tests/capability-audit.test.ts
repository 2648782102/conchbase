import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCapabilityGrants } from '../src/runtime/capability-audit.js';
import type { TaskStore } from '../src/runtime/task-store.js';
import type { AgentDetail } from '../src/runtime/agent-profile.js';
import { createApp } from '../src/http/create-app.js';

/**
 * Capability grant audit.
 *
 * The audit is read-only and must not invent authority: an unregistered grant
 * is reported as stale, not treated as if registration were implied by the
 * audit itself.
 */
function agent(id: string, grants: readonly { kind: 'tool' | 'skill'; name: string }[]): AgentDetail {
  const revision = {
    id: `agr_${id}`,
    name: id,
    instructions: 'x',
    providerId: 'magpie',
    modelId: 'm',
    grantedCapabilities: grants,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    id,
    currentRevisionId: revision.id,
    archived: false,
    isDefault: false,
    current: revision,
    revisions: [revision],
  } as unknown as AgentDetail;
}

function store(agents: readonly AgentDetail[]): Pick<TaskStore, 'listAgents' | 'getAgent'> {
  return {
    listAgents: () => agents.map((detail) => ({
      id: detail.id,
      currentRevisionId: detail.currentRevisionId,
      archived: detail.archived,
      isDefault: detail.isDefault,
      current: detail.current,
    })),
    getAgent: (id: string) => agents.find((item) => item.id === id) ?? null,
  } as never;
}

test('the audit reports current-revision grants and availability', () => {
  const fixture = store([
    agent('agt_one', [
      { kind: 'tool', name: 'workspace_read' },
      { kind: 'tool', name: 'plugin_missing' },
      { kind: 'skill', name: 'writing' },
    ]),
  ]);
  const audit = auditCapabilityGrants(fixture, ['workspace_read'], ['writing']);
  assert.equal(audit.version, 1);
  assert.equal(audit.agents.length, 1);
  assert.deepEqual(
    audit.agents[0]!.grants.map((grant) => [grant.kind, grant.name, grant.stillAvailable]),
    [
      ['tool', 'workspace_read', true],
      ['tool', 'plugin_missing', false],
      ['skill', 'writing', true],
    ],
  );
  assert.deepEqual(audit.staleGrants, [{
    agentId: 'agt_one',
    revisionId: 'agr_agt_one',
    kind: 'tool',
    name: 'plugin_missing',
  }]);
});

test('duplicate grants are reported once', () => {
  const fixture = store([
    agent('agt_dup', [
      { kind: 'tool', name: 'workspace_read' },
      { kind: 'tool', name: 'workspace_read' },
    ]),
  ]);
  const audit = auditCapabilityGrants(fixture, ['workspace_read'], []);
  assert.equal(audit.agents[0]!.grants.length, 1);
});

test('the audit publishes registered tool and skill names for a configuration UI', () => {
  const audit = auditCapabilityGrants(store([]), ['workspace_read', 'web_extract'], ['writing']);
  assert.deepEqual(audit.available.tools, ['workspace_read', 'web_extract']);
  assert.deepEqual(audit.available.skills, ['writing']);
});

test('the HTTP route exposes the audit without mutating agents', async () => {
  const detail = agent('agt_http', [{ kind: 'tool', name: 'git_status' }]);
  const fixture = store([detail]);
  const taskService = {
    store: fixture,
    availableCapabilityNames: { tools: ['workspace_read'], skills: [] },
  } as never;
  const app = createApp({ logger: false, taskService });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/agents/capability-grants' });
    assert.equal(response.statusCode, 200);
    const payload = response.json<{
      version: number;
      agents: readonly { agentId: string; grants: readonly { stillAvailable: boolean }[] }[];
      staleGrants: readonly { name: string }[];
    }>();
    assert.equal(payload.version, 1);
    assert.equal(payload.agents[0]?.agentId, 'agt_http');
    assert.equal(payload.agents[0]?.grants[0]?.stillAvailable, false);
    assert.equal(payload.staleGrants[0]?.name, 'git_status');
    // The source grant remains unchanged; the audit is a projection only.
    assert.deepEqual(detail.current.grantedCapabilities, [{ kind: 'tool', name: 'git_status' }]);
  } finally {
    await app.close();
  }
});

test('the route is unavailable without a task service', async () => {
  const app = createApp({ logger: false });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/agents/capability-grants' });
    assert.equal(response.statusCode, 503);
  } finally {
    await app.close();
  }
});
