import assert from 'node:assert/strict';
import test from 'node:test';
import { BossMemory } from '../src/runtime/boss-memory.js';
import { InMemoryAgentMemoryStore } from '../src/runtime/agent-memory.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import type { OrganizationSnapshot } from '../src/runtime/organization-contract.js';

function snapshotWith(store: InMemoryOrganizationStore): OrganizationSnapshot {
  return store.get();
}

test('what gets shown: runtime memory plus active-project memory, titles only', () => {
  const organization = new InMemoryOrganizationStore();
  organization.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_live', originTriggerId: 'i1' });
  organization.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_live' });
  const memory = new InMemoryAgentMemoryStore();
  memory.write({ scope: 'runtime', key: 'tone', title: '全局偏好', body: '正文不应出现' });
  memory.write({ scope: 'project', scopeId: 'project_live', key: 'p', title: '在办项目结论', body: '正文不应出现' });
  memory.write({ scope: 'project', scopeId: 'project_old', key: 'o', title: '已归档项目结论', body: 'x' });

  const index = new BossMemory({ memory }).index(snapshotWith(organization));
  assert.match(index, /全局偏好/);
  assert.match(index, /在办项目结论/);
  assert.doesNotMatch(index, /已归档项目结论/, 'archived project memory is not current context');
  assert.doesNotMatch(index, /正文不应出现/, 'bodies stay out of the prompt');
});

test('no memory store means an empty index, not a crash', () => {
  const organization = new InMemoryOrganizationStore();
  assert.equal(new BossMemory().index(snapshotWith(organization)), '');
});

test('what gets written: only proposals with an existing target survive', async () => {
  const organization = new InMemoryOrganizationStore();
  organization.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_alpha', originTriggerId: 'i1' });
  const memory = new InMemoryAgentMemoryStore();
  const bossMemory = new BossMemory({ memory });
  await bossMemory.recordProposals([
    { scope: 'project', scopeId: 'project_alpha', key: 'k1', title: '有效', body: 'b' },
    { scope: 'project', scopeId: 'project_missing', key: 'k2', title: '悬空', body: 'b' },
  ], {
    userText: '记住', assistantReply: '好', sourceIntentId: 'int_1', snapshot: snapshotWith(organization),
  });
  assert.equal(memory.list({ scope: 'project', scopeId: 'project_alpha' }).length, 1);
  assert.equal(memory.list({ scope: 'project', scopeId: 'project_missing' }).length, 0);
});

test('a reviewer can only narrow, and a failing reviewer writes nothing', async () => {
  const organization = new InMemoryOrganizationStore();
  organization.apply({ type: 'open_project', expectedSequence: 0, projectId: 'p', originTriggerId: 'i1' });
  const entries = [{ scope: 'project' as const, scopeId: 'p', key: 'k', title: 't', body: 'b' }];
  const context = {
    userText: '记住', assistantReply: '好', sourceIntentId: 'int_1', snapshot: snapshotWith(organization),
  };

  const rejected = new InMemoryAgentMemoryStore();
  await new BossMemory({
    memory: rejected,
    reviewer: async () => ({ version: 1, decisions: [{ index: 0, verdict: 'reject', reason: '一次性要求' }] }),
  }).recordProposals(entries, context);
  assert.equal(rejected.list({ scope: 'project', scopeId: 'p' }).length, 0);

  const failing = new InMemoryAgentMemoryStore();
  await new BossMemory({ memory: failing, reviewer: async () => null }).recordProposals(entries, context);
  assert.equal(failing.list({ scope: 'project', scopeId: 'p' }).length, 0,
    'configured-but-unavailable reviewer must not fall back to an unreviewed write');

  const accepted = new InMemoryAgentMemoryStore();
  await new BossMemory({
    memory: accepted,
    reviewer: async () => ({ version: 1, decisions: [{ index: 0, verdict: 'accept', reason: '持久偏好' }] }),
  }).recordProposals(entries, context);
  assert.equal(accepted.list({ scope: 'project', scopeId: 'p' }).length, 1);
});

test('a runtime-scope proposal needs both review and explicit confirmation', async () => {
  const organization = new InMemoryOrganizationStore();
  const entries = [{ scope: 'runtime' as const, key: 'k', title: '全局', body: 'b' }];
  const context = {
    userText: '所有项目都这样', assistantReply: '好', sourceIntentId: 'int_1', snapshot: snapshotWith(organization),
  };
  const withoutConfirmation = new InMemoryAgentMemoryStore();
  await new BossMemory({
    memory: withoutConfirmation,
    reviewer: async () => ({ version: 1, decisions: [{ index: 0, verdict: 'accept', reason: '持久' }] }),
  }).recordProposals(entries, context);
  assert.equal(withoutConfirmation.list({ scope: 'runtime' }).length, 0);

  const withConfirmation = new InMemoryAgentMemoryStore();
  await new BossMemory({
    memory: withConfirmation,
    reviewer: async () => ({
      version: 1,
      decisions: [{ index: 0, verdict: 'accept', reason: '全局', runtimeScopeConfirmed: true }],
    }),
  }).recordProposals(entries, context);
  assert.equal(withConfirmation.list({ scope: 'runtime' }).length, 1);
});
