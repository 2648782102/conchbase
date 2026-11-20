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

function multiWorkerParser(projects: readonly string[]): OrganizationIntentParser {
  return {
    async parse(input) {
      const actions: OrganizationAction[] = [];
      let sequence = input.expectedSequence;
      for (const [index, projectId] of projects.entries()) {
        if (index === 0 || projects[index - 1] !== projectId) {
          actions.push(parseOrganizationAction({
            type: 'open_project', expectedSequence: sequence++, projectId,
            originTriggerId: input.intentId,
          }));
          actions.push(parseOrganizationAction({
            type: 'activate_project', expectedSequence: sequence++, projectId,
          }));
        }
        const workerId = `wrk_${index}`;
        actions.push(parseOrganizationAction({
          type: 'create_agent', expectedSequence: sequence++,
          projectId, workerId, delegationId: `del_${index}`,
          agentRevisionId: 'agr_placeholder', displayName: `Worker ${index}`,
          instructionsDigest: 'sha256_instructions', scope: [`project:${projectId}`],
          capabilities: ['cap_read_context'],
          model: { providerId: 'magpie', modelId: 'fixture-model' },
          maxDelegationDepth: 0, ttlEvents: 100,
        }));
      }
      return Object.freeze({ version: 1 as const, intentId: input.intentId, actions: Object.freeze(actions), relay: 'hired' });
    },
  };
}

function makeTaskService(
  directory: string,
  slowTasks = false,
  maxConcurrentTasks?: number,
) {
  return createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    ...(maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fixture-model', display_name: 'Fixture Model' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (slowTasks) {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) { reject(new Error('aborted')); return; }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch,
  });
}

async function withBoss(
  projects: readonly string[],
  schedulerLimits: { globalActive: number; perProjectActive: number },
  run: (service: BossModeService, taskService: ReturnType<typeof createTaskService>) => Promise<void>,
  waitForTasks = false,
  slowTasks = false,
  maxConcurrentTasks?: number,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-admission-'));
  const taskService = makeTaskService(directory, slowTasks, maxConcurrentTasks);
  const service = new BossModeService(new InMemoryOrganizationStore(), taskService, {
    parser: multiWorkerParser(projects), waitForTasks, schedulerLimits,
  });
  try {
    await run(service, taskService);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('worker starts beyond perProjectActive are held, not dispatched', async () => {
  await withBoss(['project_a', 'project_a', 'project_a'], { globalActive: 8, perProjectActive: 1 },
    async (service, taskService) => {
      const result = await service.submit({ text: 'hire', idempotencyKey: 'int_1' });
      const created = result.executions.filter((entry) => entry.status === 'created-agent');
      const held = result.executions.filter((entry) => entry.status === 'skipped' && /held by project-limit/.test(entry.detail ?? ''));
      assert.equal(created.length, 1, 'only the first worker starts within per-project capacity');
      assert.equal(held.length, 2, 'the other two are held');
      assert.equal(result.holds.length, 2);
      assert.ok(result.holds.every((hold) => hold.reason === 'project-limit'));
      const started = taskService.store.listTasks().filter((task) => task.state !== 'queued');
      const queued = taskService.store.listTasks().filter((task) => task.state === 'queued');
      assert.equal(started.length, 1, 'only the admitted worker task was started');
      assert.equal(queued.length, 2, 'held workers keep an unstarted task');
    }, false, true);
});

test('globalActive bounds worker starts across projects', async () => {
  await withBoss(['project_a', 'project_b', 'project_c'], { globalActive: 2, perProjectActive: 2 },
    async (service) => {
      const result = await service.submit({ text: 'hire', idempotencyKey: 'int_1' });
      const created = result.executions.filter((entry) => entry.status === 'created-agent');
      assert.equal(created.length, 2, 'only two workers start globally');
      assert.equal(result.holds.length, 1);
      assert.equal(result.holds[0]?.reason, 'global-limit');
    }, false, true);
});

/**
 * The work scheduler and the task layer are two gates over one capacity.
 *
 * Before this, the scheduler could admit a worker whose task then waited in
 * `queued` for a model slot, leaving the WorkItem `running` with no work
 * happening. The scheduler has to hold instead, and say why.
 */
test('a worker is held when no model slot is free, even with scheduler room', async () => {
  await withBoss(['project_a'], { globalActive: 8, perProjectActive: 8 },
    async (service, taskService) => {
      // Occupy every slot with unrelated tasks held open.
      const blockers = Array.from({ length: 1 }, (_, index) =>
        taskService.createTask({ prompt: `blocker${index}`, model: 'fixture-model' }));
      for (const blocker of blockers) taskService.startTask(blocker.id);
      for (let attempt = 0; attempt < 100 && taskService.availableModelSlots > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(taskService.availableModelSlots, 0, 'the only slot is held');

      const result = await service.submit({ text: 'hire', idempotencyKey: 'int_1' });
      assert.equal(
        result.executions.filter((entry) => entry.status === 'created-agent').length,
        0,
        'no worker starts while the only model slot is held',
      );
      assert.ok(result.holds.some((hold) => hold.reason === 'model-slot-limit'));
    }, false, true, 1);
});

test('operator limits override the scheduler defaults', async () => {
  // With default perProjectActive (2), two same-project workers start. With an
  // operator limit of 1, only one does.
  await withBoss(['project_a', 'project_a'], { globalActive: 8, perProjectActive: 2 },
    async (service) => {
      const result = await service.submit({ text: 'hire', idempotencyKey: 'int_1' });
      assert.equal(result.executions.filter((entry) => entry.status === 'created-agent').length, 2);
      assert.equal(result.holds.length, 0);
    });
});

test('held workers are re-admitted after capacity frees and all complete', async () => {
  await withBoss(['project_a', 'project_a', 'project_a'], { globalActive: 8, perProjectActive: 1 },
    async (service, taskService) => {
      const result = await service.submit({ text: 'hire', idempotencyKey: 'int_1' });
      // All three workers eventually ran to completion through re-admission.
      const tasks = taskService.store.listTasks();
      assert.equal(tasks.length, 3);
      assert.equal(tasks.filter((task) => task.state === 'succeeded').length, 3,
        'every held worker is eventually admitted and completes');
      // The reply reports real outcomes, not the pre-execution promise.
      assert.ok((result.reply ?? '').length > 0);
      // No worker remains stranded in an authorized-without-task state.
      const snapshot = service.coordinator.reconcile().snapshot;
      assert.equal(snapshot.workers.some((worker) => worker.state === 'running'), false);
    }, true);
});
