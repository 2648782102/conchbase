import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import type { OrganizationIntentParser } from '../src/runtime/organization-intent-parser.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';

function createService(parser: OrganizationIntentParser) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-resume-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  const service = new BossModeService(store, taskService, { parser, waitForTasks: false });
  return { directory, taskService, store, service };
}

test('an archived project can be resumed and dispatch fresh work', async () => {
  let step = 0;
  const parser: OrganizationIntentParser = {
    async parse(input) {
      step += 1;
      const base = input.expectedSequence;
      if (step === 1) {
        return Object.freeze({
          version: 1 as const,
          intentId: input.intentId,
          actions: Object.freeze([
            Object.freeze({ type: 'open_project' as const, expectedSequence: base, projectId: 'project_resume', originTriggerId: input.intentId }),
            Object.freeze({ type: 'activate_project' as const, expectedSequence: base + 1, projectId: 'project_resume' }),
            Object.freeze({
              type: 'create_agent' as const,
              expectedSequence: base + 2,
              projectId: 'project_resume',
              workerId: 'wrk_resume',
              delegationId: 'del_resume',
              agentRevisionId: 'agr_placeholder',
              displayName: '恢复测试员工',
              instructionsDigest: 'sha256:instructions',
              scope: ['project:resume'],
              capabilities: ['cap_read_context'],
              model: { providerId: 'magpie', modelId: 'fixture-model' },
              maxDelegationDepth: 0,
              ttlEvents: 100,
            }),
          ]),
          relay: '已创建。',
        });
      }
      if (step === 2) {
        return Object.freeze({
          version: 1 as const,
          intentId: input.intentId,
          actions: Object.freeze([
            Object.freeze({ type: 'archive_project' as const, expectedSequence: base, projectId: 'project_resume' }),
          ]),
          relay: '已归档。',
        });
      }
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze([
          Object.freeze({ type: 'resume_project' as const, expectedSequence: base, projectId: 'project_resume', revalidatedDelegationId: 'del_resume' }),
        ]),
        relay: '已恢复。',
      });
    },
  };
  const { directory, taskService, store, service } = createService(parser);
  try {
    await service.submit({ text: '开项目', idempotencyKey: 'resume-1' });
    const created = store.get();
    const agentId = created.workers[0]?.agentRevisionId;
    assert.ok(agentId, 'worker must have a pinned revision');
    const agentsBefore = taskService.store.listAgents();
    assert.equal(agentsBefore.length, 1);

    await service.submit({ text: '归档', idempotencyKey: 'resume-2' });
    assert.equal(store.get().projects[0]?.state, 'archived');
    assert.equal(taskService.store.listAgents()[0]?.archived, true, 'offboard archives the Agent');

    const resumed = await service.submit({ text: '恢复', idempotencyKey: 'resume-3' });
    assert.equal(store.get().projects[0]?.state, 'resumed');
    const tests = resumed.executions.map((execution) => `${execution.action.type}:${execution.status}:${execution.detail ?? ''}`);
    // Resume recreates an Agent; the archived original legitimately remains in
    // the list as history, so assert on the Agent the worker is bound to rather
    // than on list order.
    const bound = service.getDynamicAgentRevisionId('wrk_resume');
    assert.ok(bound, `resumed work needs a usable Agent: ${tests.join(' | ')}`);
    const usable = taskService.store.listAgents().filter((agent) => !agent.archived);
    assert.equal(usable.length, 1, `exactly one usable Agent after resume: ${tests.join(' | ')}`);
    assert.equal(
      taskService.store.getAgent(usable[0]!.id)?.currentRevisionId,
      bound,
      'the worker is bound to the usable Agent revision',
    );
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
