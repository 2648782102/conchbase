import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTaskCapabilities } from '../src/runtime/task-capabilities.js';
import type { AgentId, AgentRevisionId, CapabilityGrant } from '../src/runtime/agent-profile.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

const tool = (id: string): ToolProvider => ({
  list: () => [{ id, version: 1, description: id, sideEffect: 'read' }],
  has: (candidate) => candidate === id,
  invoke: () => ({ ok: true, summary: 'ok', digest: 'sha256:x', bytes: 1 }),
});

function storeWith(grants: readonly CapabilityGrant[] | null) {
  return {
    getAgentRevision: () => (grants === null ? null : {
      id: 'agr_1' as AgentRevisionId,
      name: 'x',
      instructions: 'x',
      providerId: 'magpie',
      modelId: 'm',
      grantedCapabilities: grants,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  } as never;
}

test('a task with no Agent gets no tools and no Skills', () => {
  const resolved = resolveTaskCapabilities(
    storeWith([]),
    { tools: tool('workspace_read'), skills: [{ name: 'writing', instructions: 'x' }] },
    {},
  );
  assert.equal(resolved.tools, undefined);
  assert.deepEqual([...resolved.skills], []);
});

test('grants narrow the runtime-wide providers', () => {
  const read = tool('workspace_read');
  const write = tool('workspace_write');
  const combined: ToolProvider = {
    list: () => [...read.list(), ...write.list()],
    has: () => true,
    invoke: () => ({ ok: true, summary: 'ok', digests: '', bytes: 1 } as never),
  };
  const resolved = resolveTaskCapabilities(
    storeWith([{ kind: 'tool', name: 'workspace_read' }]),
    { tools: combined, skills: [{ name: 'writing', instructions: 'x' }, { name: 'other', instructions: 'y' }] },
    { agentId: 'agt_1' as AgentId, agentRevisionId: 'agr_1' as AgentRevisionId },
  );
  assert.deepEqual(resolved.tools?.list().map((entry) => entry.id), ['workspace_read']);
  assert.deepEqual(resolved.skills.map((entry) => entry.name), []);
});

test('a pinned revision is used, so editing the Agent cannot widen a running task', () => {
  // A missing revision must yield no grants rather than falling back to the
  // Agent's current capabilities.
  const resolved = resolveTaskCapabilities(
    { getAgentRevision: () => null } as never,
    { tools: tool('workspace_read') },
    { agentId: 'agt_1' as AgentId, agentRevisionId: 'agr_missing' as AgentRevisionId },
  );
  assert.equal(resolved.tools, undefined);
});

test('an unregistered grant is inert rather than an error', () => {
  const resolved = resolveTaskCapabilities(
    storeWith([{ kind: 'tool', name: 'plugin_unknown' }]),
    { tools: tool('workspace_read') },
    { agentId: 'agt_1' as AgentId, agentRevisionId: 'agr_1' as AgentRevisionId },
  );
  assert.equal(resolved.tools, undefined);
});
