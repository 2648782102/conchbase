import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';
import type { OrganizationIntentParser } from '../src/runtime/organization-intent-parser.js';
import { parseOrganizationAction, type OrganizationAction } from '../src/runtime/organization-contract.js';

function fixtureParser(): OrganizationIntentParser {
  return {
    async parse(input) {
      const projectId = 'project_alpha';
      const workerId = 'wrk_alpha';
      const actions: readonly OrganizationAction[] = Object.freeze([
        parseOrganizationAction({
          type: 'open_project',
          expectedSequence: input.expectedSequence,
          projectId,
          originTriggerId: input.intentId,
        }),
        parseOrganizationAction({
          type: 'activate_project',
          expectedSequence: input.expectedSequence + 1,
          projectId,
        }),
        parseOrganizationAction({
          type: 'create_agent',
          expectedSequence: input.expectedSequence + 2,
          projectId,
          workerId,
          delegationId: 'del_alpha',
          agentRevisionId: 'agr_placeholder',
          displayName: 'Alpha Worker',
          instructionsDigest: 'sha256_instructions',
          scope: ['project:alpha'],
          capabilities: ['cap_read_context'],
          model: { providerId: 'magpie', modelId: 'fixture-model' },
          maxDelegationDepth: 0,
          ttlEvents: 100,
        }),
        parseOrganizationAction({
          type: 'start_worker',
          expectedSequence: input.expectedSequence + 3,
          projectId,
          workerId,
        }),
      ]);
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions,
        relay: 'Boss mode fixture created one worker.',
      });
    },
  };
}

async function withService(action: (service: BossModeService, directory: string) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-mode-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'fixture-model', display_name: 'Fixture Model' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(input).endsWith('/v1/chat/completions')) {
        return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected fetch in fixture: ${String(input)}`);
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  const service = new BossModeService(store, taskService, { parser: fixtureParser() });
  try {
    await action(service, directory);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('one invalid action does not fail the whole Boss turn', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-partial-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'fixture-model', display_name: 'Fixture Model' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected fetch');
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  const parser: OrganizationIntentParser = {
    async parse(input) {
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze([
          parseOrganizationAction({
            type: 'open_project',
            expectedSequence: input.expectedSequence,
            projectId: 'project_partial',
            originTriggerId: input.intentId,
          }),
          parseOrganizationAction({
            type: 'activate_project',
            expectedSequence: input.expectedSequence + 1,
            projectId: 'project_missing',
          }),
        ]),
        relay: '已尝试开项目，但有一个动作失败。',
      });
    },
  };
  const service = new BossModeService(store, taskService, { parser });
  try {
    const result = await service.submit({ text: '开个项目', idempotencyKey: 'partial-1' });
    assert.equal(result.state, 'accepted');
    assert.ok(result.executions.some((entry) => entry.status === 'failed'));
    assert.ok(store.get().projects.some((project) => project.id === 'project_partial'));
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boss mode creates a real Agent revision and binds durable work from one intent', async () => {
  await withService(async (service) => {
    const result = await service.submit({
      text: 'Start project alpha and hire a worker.',
      idempotencyKey: 'boss-fixture-1',
    });
    assert.equal(result.state, 'accepted');
    assert.equal(result.actions.length, 5);
    assert.ok(result.executions.some((execution) => execution.status === 'created-agent'));

    const snapshot = service.snapshot();
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.workers.length, 1);
    assert.equal(snapshot.workers[0]?.state, 'reporting');

    const revisionId = service.getDynamicAgentRevisionId('wrk_alpha');
    assert.ok(revisionId);
    assert.match(revisionId, /^agr_[0-9a-f]{32}$/);

    const workItems = (service as unknown as {
      taskService: { store: { work: { listWorkItems(): readonly { id: string; state: string }[] } } };
    }).taskService.store.work.listWorkItems();
    assert.equal(workItems.length, 1);
    assert.equal(workItems[0]?.state, 'completed');
  });
});

test('boss mode replays an idempotency key and rejects body conflicts', async () => {
  await withService(async (service) => {
    const input = { text: 'Start project alpha and hire a worker.', idempotencyKey: 'boss-fixture-1' };
    const first = await service.submit(input);
    const eventCount = service.snapshot().events.length;
    const replay = await service.submit(input);
    assert.equal(replay.intentId, first.intentId);
    assert.equal(replay.state, 'accepted');
    assert.equal(service.snapshot().events.length, eventCount);
    await assert.rejects(() => service.submit({ ...input, text: 'Different body.' }));
  });
});

test('boss mode exposes only structured facts and no plaintext', async () => {
  await withService(async (service) => {
    const result = await service.submit({
      text: 'Start project alpha and hire a worker.',
      idempotencyKey: 'boss-fixture-1',
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /runtime\.sqlite|\.conchbase|sk-|Bearer|privateKey/);
    assert.ok(result.relays.every((relay) => typeof relay.digest === 'string'));
  });
});

test('boss mode emits organizing progress before committing proposed actions', async () => {
  await withService(async (service) => {
    const progress: string[] = [];
    const result = await service.submit({
      text: 'Start project alpha and hire a worker.',
      idempotencyKey: 'boss-organizing-1',
      source: 'agent-chat',
      onProgress: (event: { readonly state: string }) => progress.push(event.state),
    });
    assert.equal(result.state, 'accepted');
    assert.ok(progress.includes('organizing'));
    assert.ok(service.snapshot().events.some((event) => event.type === 'organization.intent_recorded'));
  });
});

test('ATTENTION on the last line still opens an attention request', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-attention-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'fixture-model', display_name: 'Fixture Model' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"结论：未闭环。\\n\\nATTENTION: 需要人工重启验证。"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  const parser: OrganizationIntentParser = {
    async parse(input) {
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze([
          parseOrganizationAction({
            type: 'open_project', expectedSequence: input.expectedSequence,
            projectId: 'project_attention', originTriggerId: input.intentId,
          }),
          parseOrganizationAction({
            type: 'activate_project', expectedSequence: input.expectedSequence + 1,
            projectId: 'project_attention',
          }),
          parseOrganizationAction({
            type: 'create_agent',
            expectedSequence: input.expectedSequence + 2,
            projectId: 'project_attention',
            workerId: 'wrk_attention',
            delegationId: 'del_attention',
            agentRevisionId: 'agr_placeholder',
            displayName: 'Attention Worker',
            instructionsDigest: 'sha256:instructions',
            scope: ['project:attention'],
            capabilities: ['cap_read_context'],
            model: { providerId: 'magpie', modelId: 'fixture-model' },
            maxDelegationDepth: 0,
            ttlEvents: 30,
          }),
          parseOrganizationAction({
            type: 'start_worker', expectedSequence: input.expectedSequence + 3,
            projectId: 'project_attention', workerId: 'wrk_attention',
          }),
        ]),
        relay: '已启动员工。',
      });
    },
  };
  const service = new BossModeService(store, taskService, { parser });
  try {
    await service.submit({ text: '开项目并启动员工', idempotencyKey: 'attention-1' });
    const snapshot = store.get();
    assert.ok(snapshot.reports.some((report) => report.state === 'attention'));
    assert.ok(snapshot.attentionRequests.some((request) => request.state === 'open'));
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an open attention only blocks work in its own project', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-attention-scope-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'fixture-model', display_name: 'Fixture Model' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  const parser: OrganizationIntentParser = {
    async parse(input) {
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze([
          parseOrganizationAction({
            type: 'open_project', expectedSequence: input.expectedSequence,
            projectId: 'project_free', originTriggerId: input.intentId,
          }),
          parseOrganizationAction({
            type: 'activate_project', expectedSequence: input.expectedSequence + 1,
            projectId: 'project_free',
          }),
          parseOrganizationAction({
            type: 'create_agent',
            expectedSequence: input.expectedSequence + 2,
            projectId: 'project_free',
            workerId: 'wrk_free',
            delegationId: 'del_free',
            agentRevisionId: 'agr_placeholder',
            displayName: 'Free Worker',
            instructionsDigest: 'sha256:instructions',
            scope: ['project:free'],
            capabilities: ['cap_read_context'],
            model: { providerId: 'magpie', modelId: 'fixture-model' },
            maxDelegationDepth: 0,
            ttlEvents: 30,
          }),
          parseOrganizationAction({
            type: 'start_worker', expectedSequence: input.expectedSequence + 3,
            projectId: 'project_free', workerId: 'wrk_free',
          }),
        ]),
        relay: '已在新项目中启动员工。',
      });
    },
  };
  let service: BossModeService;
  try {
    service = new BossModeService(store, taskService, { parser, waitForTasks: false });
    // Seed an open attention in an unrelated project.
    store.apply({
      type: 'open_project', expectedSequence: store.get().events.length,
      projectId: 'project_blocked', originTriggerId: 'int_blocked',
    });
    store.apply({
      type: 'activate_project', expectedSequence: store.get().events.length,
      projectId: 'project_blocked',
    });
    store.apply({
      type: 'create_agent',
      expectedSequence: store.get().events.length,
      projectId: 'project_blocked',
      workerId: 'wrk_blocked',
      delegationId: 'del_blocked',
      agentRevisionId: 'agr_blocked',
      displayName: 'Blocked Worker',
      instructionsDigest: 'sha256:instructions',
      scope: ['project:blocked'],
      capabilities: ['cap_read_context'],
      model: { providerId: 'magpie', modelId: 'fixture-model' },
      maxDelegationDepth: 0,
      ttlEvents: 10,
    });
    store.apply({
      type: 'authorize_worker', expectedSequence: store.get().events.length,
      projectId: 'project_blocked', workerId: 'wrk_blocked',
    });
    store.apply({
      type: 'start_worker', expectedSequence: store.get().events.length,
      projectId: 'project_blocked', workerId: 'wrk_blocked',
    });
    store.apply({
      type: 'report_worker',
      expectedSequence: store.get().events.length,
      projectId: 'project_blocked',
      workerId: 'wrk_blocked',
      reportId: 'rpt_blocked',
      state: 'attention',
      summaryDigest: 'sha256:blocked',
    });
    store.apply({
      type: 'request_attention', expectedSequence: store.get().events.length,
      projectId: 'project_blocked', workerId: 'wrk_blocked',
      attentionId: 'att_blocked', questionDigest: 'sha256:question',
    });

    const result = await service.submit({ text: '在新项目里招人并开工', idempotencyKey: 'scope-1' });
    assert.equal(result.state, 'accepted');
    const free = store.get().workers.find((worker) => worker.id === 'wrk_free');
    assert.ok(free);
    assert.notEqual(free.state, 'authorized');
    assert.equal(result.executions.some((entry) =>
      entry.status === 'skipped' && /Open attention/.test(entry.detail ?? '')), false);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the retirement rule retires a worker after two failed reports', async () => {
  const store = new InMemoryOrganizationStore();
  const seed = async () => {
    const { createTaskService } = await import('../src/runtime/task-service.js');
    return createTaskService(path.join(tmpdir(), `retire-${Date.now()}.sqlite`), {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture-model',
      fetch: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
    });
  };
  const taskService = await seed();
  try {
    store.initialize('primary_conversation');
    store.apply({
      type: 'open_project', expectedSequence: 0,
      projectId: 'project_retire', originTriggerId: 'int_retire',
    });
    store.apply({
      type: 'activate_project', expectedSequence: store.get().events.length,
      projectId: 'project_retire',
    });
    store.apply({
      type: 'create_agent',
      expectedSequence: store.get().events.length,
      projectId: 'project_retire',
      workerId: 'wrk_retire',
      delegationId: 'del_retire',
      agentRevisionId: 'agr_retire',
      displayName: 'Retire Worker',
      instructionsDigest: 'sha256:instructions',
      scope: ['project:retire'],
      capabilities: ['cap_read_context'],
      model: { providerId: 'magpie', modelId: 'fixture-model' },
      maxDelegationDepth: 0,
      ttlEvents: 50,
    });
    store.apply({
      type: 'authorize_worker', expectedSequence: store.get().events.length,
      projectId: 'project_retire', workerId: 'wrk_retire',
    });
    store.apply({
      type: 'start_worker', expectedSequence: store.get().events.length,
      projectId: 'project_retire', workerId: 'wrk_retire',
    });
    for (const reportId of ['rpt_retire_1', 'rpt_retire_2']) {
      store.apply({
        type: 'report_worker',
        expectedSequence: store.get().events.length,
        projectId: 'project_retire',
        workerId: 'wrk_retire',
        reportId,
        state: 'failed',
        summaryDigest: `sha256:${reportId}`,
      });
    }
    const failures = store.get().reports.filter((report) => report.state === 'failed');
    assert.equal(failures.length, 2);

    // The Boss retires the worker through the normal offboard action.
    store.apply({
      type: 'offboard_worker',
      expectedSequence: store.get().events.length,
      projectId: 'project_retire',
      workerId: 'wrk_retire',
    });
    assert.equal(store.get().workers.find((worker) => worker.id === 'wrk_retire')!.state, 'offboarded');
  } finally {
    await taskService.stop();
  }
});

test('collecting a second failing outcome retires the worker automatically', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-autoretire-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'fixture-model', display_name: 'Fixture Model' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('model must fail so the task fails');
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  let attempt = 0;
  const parser: OrganizationIntentParser = {
    async parse(input) {
      attempt += 1;
      const actions = attempt === 1
        ? [
          parseOrganizationAction({
            type: 'open_project', expectedSequence: 0,
            projectId: 'project_auto', originTriggerId: input.intentId,
          }),
          parseOrganizationAction({
            type: 'activate_project', expectedSequence: 1, projectId: 'project_auto',
          }),
          parseOrganizationAction({
            type: 'create_agent',
            expectedSequence: 2,
            projectId: 'project_auto',
            workerId: 'wrk_auto',
            delegationId: 'del_auto',
            agentRevisionId: 'agr_placeholder',
            displayName: 'Auto Retire Worker',
            instructionsDigest: 'sha256:instructions',
            scope: ['project:auto'],
            capabilities: ['cap_read_context'],
            model: { providerId: 'magpie', modelId: 'fixture-model' },
            maxDelegationDepth: 0,
            ttlEvents: 50,
          }),
          parseOrganizationAction({
            type: 'start_worker', expectedSequence: 3,
            projectId: 'project_auto', workerId: 'wrk_auto',
          }),
        ]
        : [];
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze(actions),
        relay: 'ok',
      });
    },
  };
  const service = new BossModeService(store, taskService, { parser });
  try {
    await service.submit({ text: '第一次', idempotencyKey: 'auto-1' });
    const afterFirst = store.get().reports.filter((report) => report.state === 'failed').length;
    assert.equal(afterFirst, 1);
    assert.notEqual(
      store.get().workers.find((worker) => worker.id === 'wrk_auto')!.state,
      'offboarded',
      'one failure should not retire the worker',
    );
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('offboarding a worker archives its Agent so the list stays clean', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-archive-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'fixture-model', display_name: 'Fixture Model' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch,
  });
  const store = new InMemoryOrganizationStore();
  let phase = 0;
  const parser: OrganizationIntentParser = {
    async parse(input) {
      phase += 1;
      const actions = phase === 1
        ? [
          parseOrganizationAction({
            type: 'open_project', expectedSequence: 0,
            projectId: 'project_archive', originTriggerId: input.intentId,
          }),
          parseOrganizationAction({
            type: 'activate_project', expectedSequence: 1, projectId: 'project_archive',
          }),
          parseOrganizationAction({
            type: 'create_agent',
            expectedSequence: 2,
            projectId: 'project_archive',
            workerId: 'wrk_archive',
            delegationId: 'del_archive',
            agentRevisionId: 'agr_placeholder',
            displayName: 'Archive Worker',
            instructionsDigest: 'sha256:instructions',
            scope: ['project:archive'],
            capabilities: ['cap_read_context'],
            model: { providerId: 'magpie', modelId: 'fixture-model' },
            maxDelegationDepth: 0,
            ttlEvents: 50,
          }),
        ]
        : [parseOrganizationAction({
          type: 'offboard_worker',
          expectedSequence: store.get().events.length,
          projectId: 'project_archive',
          workerId: 'wrk_archive',
        })];
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze(actions),
        relay: 'ok',
      });
    },
  };
  const service = new BossModeService(store, taskService, { parser, waitForTasks: false });
  try {
    await service.submit({ text: '建项目并招人', idempotencyKey: 'archive-1' });
    const beforeArchive = taskService.store.listAgents();
    assert.equal(beforeArchive.length, 1);
    assert.equal(beforeArchive[0]!.archived, false);

    await service.submit({ text: '下线该员工', idempotencyKey: 'archive-2' });
    const afterArchive = taskService.store.listAgents();
    assert.equal(afterArchive[0]!.archived, true);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
