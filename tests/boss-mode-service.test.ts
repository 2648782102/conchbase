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
