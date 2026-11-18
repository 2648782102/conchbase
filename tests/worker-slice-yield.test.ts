import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import type { OrganizationIntentParser } from '../src/runtime/organization-intent-parser.js';
import { parseOrganizationAction, type OrganizationAction } from '../src/runtime/organization-contract.js';

function oneWorkerParser(): OrganizationIntentParser {
  return {
    async parse(input) {
      const projectId = 'project_a';
      const workerId = 'wrk_a';
      const actions: readonly OrganizationAction[] = Object.freeze([
        parseOrganizationAction({ type: 'open_project', expectedSequence: input.expectedSequence, projectId, originTriggerId: input.intentId }),
        parseOrganizationAction({ type: 'activate_project', expectedSequence: input.expectedSequence + 1, projectId }),
        parseOrganizationAction({
          type: 'create_agent', expectedSequence: input.expectedSequence + 2,
          projectId, workerId, delegationId: 'del_a', agentRevisionId: 'agr_placeholder',
          displayName: 'Worker A', instructionsDigest: 'sha256_instructions',
          scope: ['project:project_a'], capabilities: ['cap_read_context'],
          model: { providerId: 'magpie', modelId: 'fixture-model' },
          maxDelegationDepth: 0, ttlEvents: 100,
        }),
      ]);
      return Object.freeze({ version: 1 as const, intentId: input.intentId, actions, relay: 'hired' });
    },
  };
}

function toolCall(): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {
    tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'workspace_list', arguments: '{"path":"."}' } }],
  }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}
function finalText(): string {
  return 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
}

async function withBoss(
  toolTurns: number,
  sliceIterations: number,
  run: (service: BossModeService, taskService: ReturnType<typeof createTaskService>, directory: string) => Promise<void>,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-slice-'));
  let calls = 0;
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fixture-model', display_name: 'Fixture Model' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      calls += 1;
      return new Response(calls <= toolTurns ? toolCall() : finalText(), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch,
  }, { tools: createBuiltinReadTools({ root: directory }) });
  const service = new BossModeService(new InMemoryOrganizationStore(), taskService, {
    parser: oneWorkerParser(), waitForTasks: true, workerSliceIterations: sliceIterations,
    workerCapabilityGrants: () => [{ kind: 'tool', name: 'workspace_list' }] as never,
  });
  try {
    await run(service, taskService, directory);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a worker yields at the slice boundary, pauses, then resumes from its checkpoint', async () => {
  await withBoss(2, 1, async (service, taskService) => {
    const result = await service.submit({ text: 'work', idempotencyKey: 'int_1' });
    const tasks = taskService.store.listTasks();
    assert.equal(tasks.length, 1, 'the same task is resumed in place (no rebind)');
    assert.equal(tasks[0]?.state, 'succeeded', 'the worker completes after resuming');
    // Two tool iterations executed once each, no duplicate execution on resume.
    const events = taskService.store.listEvents(null);
    assert.equal(events.filter((event) => event.type === 'agent_loop.tool_executed').length, 2);
    // Two slice yields, each followed by a paused work item, then completion.
    assert.ok(events.some((event) => event.type === 'task.interrupted'));
    assert.ok(events.some((event) => event.type === 'task.resumed'));
    const platformEvents = taskService.store.platform.listWorkEvents();
    assert.ok(platformEvents.some((event) => event.type === 'work.paused'));
    assert.ok(platformEvents.some((event) => event.type === 'work.started'));
    const snapshot = service.coordinator.reconcile().snapshot;
    assert.ok(snapshot.reports.some((report) => report.state === 'waiting'), 'a waiting (yield) report is recorded');
    assert.ok((result.reply ?? '').length > 0);
  });
});

test('sliceIterations 0 keeps the current single-slice behavior', async () => {
  await withBoss(2, 0, async (service, taskService) => {
    await service.submit({ text: 'work', idempotencyKey: 'int_1' });
    const events = taskService.store.listEvents(null);
    assert.equal(events.some((event) => event.type === 'task.resumed'), false, 'no mid-task resume when yielding is disabled');
    assert.equal(taskService.store.listTasks()[0]?.state, 'succeeded');
  });
});
