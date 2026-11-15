import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BOSS_AGENT_ID, AgentChatService } from '../src/runtime/agent-chat.js';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import type { OrganizationIntentParser } from '../src/runtime/organization-intent-parser.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { projectTaskIds } from '../src/runtime/organization-convergence-runtime.js';
import { createApp } from '../src/http/create-app.js';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

function deliverableParser(): OrganizationIntentParser {
  return {
    async parse(input) {
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze([
          Object.freeze({
            type: 'open_project' as const,
            expectedSequence: input.expectedSequence,
            projectId: 'project_report',
            originTriggerId: input.intentId,
          }),
          Object.freeze({
            type: 'activate_project' as const,
            expectedSequence: input.expectedSequence + 1,
            projectId: 'project_report',
          }),
        ]),
        relay: '已开项目。',
      });
    },
  };
}

test('an archived project reports itself into the Boss conversation once', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-converge-runtime-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
  });
  try {
    const organization = new InMemoryOrganizationStore();
    const store = organization;
    const bossMode = new BossModeService(store, taskService, {
      parser: deliverableParser(),
      waitForTasks: false,
    });
    const agentChat = new AgentChatService(taskService, bossMode);

    // Seed a project that produced a real worker report.
    store.apply({
      type: 'open_project', expectedSequence: 0,
      projectId: 'project_report', originTriggerId: 'int_report',
    });
    store.apply({
      type: 'activate_project', expectedSequence: 1, projectId: 'project_report',
    });
    store.apply({
      type: 'create_agent',
      expectedSequence: 2,
      projectId: 'project_report',
      workerId: 'wrk_report',
      delegationId: 'del_report',
      agentRevisionId: 'agr_report',
      displayName: '报告员工',
      instructionsDigest: 'sha256:instructions',
      scope: ['project:report'],
      capabilities: ['cap_read_context'],
      model: { providerId: 'magpie', modelId: 'fixture-model' },
      maxDelegationDepth: 0,
      ttlEvents: 30,
    });
    store.apply({
      type: 'authorize_worker', expectedSequence: 3,
      projectId: 'project_report', workerId: 'wrk_report',
    });
    store.apply({
      type: 'start_worker', expectedSequence: 4,
      projectId: 'project_report', workerId: 'wrk_report',
    });
    store.apply({
      type: 'report_worker',
      expectedSequence: 5,
      projectId: 'project_report',
      workerId: 'wrk_report',
      reportId: 'rpt_report',
      state: 'ready',
      summaryDigest: 'sha256:summary',
    });
    store.recordReportText?.('rpt_report', '交付了测试报告');

    // The user has a Boss conversation that the Runtime may speak into.
    const conversation = await agentChat.createConversation({ agentId: BOSS_AGENT_ID });

    // No task is bound to this project, so the sweep may converge it.
    assert.deepEqual(projectTaskIds(store.get(), 'project_report'), []);

    let now = 10_000_000;
    const { createConvergenceRuntime } = await import('../src/runtime/organization-convergence-runtime.js');
    let invoked = false;
    const convergence = createConvergenceRuntime({
      store,
      taskService,
      agentChat,
      policy: { idleAfterMs: 100, convergeWithOpenAttention: false },
      now: () => now,
      onWorkerOffboarded: () => { invoked = true; },
    });
    await convergence.sweep();
    now += 500;
    const result = await convergence.sweep();
    assert.equal(result.converged.length, 1);
    assert.equal(invoked, true);
    assert.equal(store.get().projects.find((project) => project.id === 'project_report')?.state, 'archived');

    // The announcement is asynchronous; the durable archive already happened.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const view = agentChat.view(conversation.id);
      const notices = view.messages.filter((message) => /项目 project_report：/.test(message.body));
      if (notices.length > 0) {
        assert.match(notices[0]!.body, /交付了测试报告/);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const view = agentChat.view(conversation.id);
    assert.equal(view.messages.filter((message) => /项目 project_report：/.test(message.body)).length, 1,
      'a convergence announces exactly once');
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the runtime publishes the convergence policy it enforces', async () => {
  // A client must be able to observe the retention window rather than guess it.
  // The value is operator configuration and cannot be set through any route.
  async function runtimeFor(env: NodeJS.ProcessEnv) {
    const app = createApp({ logger: false, config: loadRuntimeConfig(env) });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/runtime' });
      return response.json<{ projectConvergence?: { idleAfterMs: number } }>();
    } finally {
      await app.close();
    }
  }
  assert.deepEqual((await runtimeFor({ CONCHBASE_PROJECT_IDLE_MS: '120000' })).projectConvergence, {
    idleAfterMs: 120_000,
  });
});

test('app startup shares one Agent Chat instance with the sweeper', async () => {
  // A live probe found the notice missing from the user's conversation even
  // though it had been written: main.ts created one AgentChatService for the API
  // and another for the sweeper, and the in-memory caches diverged. Read the
  // startup sources so the invariant is pinned where the mistake happened.
  const { readFileSync } = await import('node:fs');
  for (const file of ['../src/main.ts', '../src/cli.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /agentChatService: agentChat/, `${file} must pass the shared instance to createApp`);
    assert.equal(
      (source.match(/new AgentChatService\(/g) ?? []).length,
      1,
      `${file} must construct exactly one AgentChatService`,
    );
  }
});
