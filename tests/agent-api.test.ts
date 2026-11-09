import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

function fixtureCatalog(): ModelCatalogClient {
  return {
    async listModels() {
      return Object.freeze([
        Object.freeze({ id: 'fixture/model-a', displayName: 'Fixture A' }),
        Object.freeze({ id: 'fixture/model-b', displayName: 'Fixture B' }),
      ]);
    },
  };
}

test('Agent API preserves independent revisions and binds task and event identity', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-api-'));
  const prompts: string[] = [];
  const requestedModels: string[] = [];
  const service = new TaskService(new SqliteTaskStore(path.join(directory, 'runtime.sqlite')), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model-a',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      prompts.push(body.messages[0]?.content ?? '');
      requestedModels.push(body.model);
      return new Response('data: ' + JSON.stringify({
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
      }) + '\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  }, fixtureCatalog());
  const app = createApp({ logger: false, taskService: service });

  try {
    const catalog = await app.inject({ method: 'GET', url: '/v1/model-catalog' });
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json<{ models: { providerId: string; modelId: string }[] }>().models
      .map(({ providerId, modelId }) => [providerId, modelId]), [
      ['magpie', 'fixture/model-a'],
      ['magpie', 'fixture/model-b'],
    ]);

    const create = async (name: string, modelId: string, instructions: string) => app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name, instructions, providerId: 'magpie', modelId },
    });
    const firstResponse = await create('Agent A', 'fixture/model-a', 'Use concise wording.');
    const secondResponse = await create('Agent B', 'fixture/model-b', 'Explain every step.');
    assert.equal(firstResponse.statusCode, 201);
    assert.equal(secondResponse.statusCode, 201);
    const first = firstResponse.json<{ agent: { id: string; currentRevisionId: string; isDefault: boolean } }>().agent;
    const second = secondResponse.json<{ agent: { id: string; currentRevisionId: string; isDefault: boolean } }>().agent;
    assert.notEqual(first.id, second.id);
    assert.equal(first.isDefault, true);
    assert.equal(second.isDefault, false);

    const initialDefault = await app.inject({ method: 'GET', url: '/v1/agents/default' });
    assert.equal(initialDefault.json<{ agent: { id: string } }>().agent.id, first.id);
    const changedDefault = await app.inject({
      method: 'PUT', url: '/v1/agents/default', payload: { agentId: second.id },
    });
    assert.equal(changedDefault.json<{ agent: { id: string } }>().agent.id, second.id);
    const clearedDefault = await app.inject({
      method: 'PUT', url: '/v1/agents/default', payload: { agentId: null },
    });
    assert.equal(clearedDefault.json<{ agent: null }>().agent, null);
    const resetDefault = await app.inject({
      method: 'PUT', url: '/v1/agents/default', payload: { agentId: first.id },
    });
    assert.equal(resetDefault.json<{ agent: { id: string } }>().agent.id, first.id);

    const taskResponse = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        prompt: 'Answer this.',
        agentId: first.id,
        modelOverride: { providerId: 'magpie', modelId: 'fixture/model-b' },
      },
    });
    assert.equal(taskResponse.statusCode, 202);
    const task = taskResponse.json<{ task: {
      id: string; agentId: string; agentRevisionId: string; providerId: string; modelId: string;
      configurationRevisionId: string;
    } }>().task;
    await service.waitForTask(task.id);
    assert.equal(task.agentId, first.id);
    assert.equal(task.agentRevisionId, first.currentRevisionId);
    assert.equal(task.providerId, 'magpie');
    assert.equal(task.modelId, 'fixture/model-b');
    assert.equal(task.configurationRevisionId, service.activeConfigurationRevisionId);
    assert.match(prompts[0] ?? '', /Use concise wording/);
    assert.match(prompts[0] ?? '', /Answer this\./);
    assert.equal(requestedModels[0], 'fixture/model-b');

    const secondTaskResponse = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { prompt: 'Explain this.', agentId: second.id },
    });
    assert.equal(secondTaskResponse.statusCode, 202);
    const secondTask = secondTaskResponse.json<{ task: {
      id: string; agentId: string; agentRevisionId: string; providerId: string; modelId: string;
    } }>().task;
    await service.waitForTask(secondTask.id);
    assert.equal(secondTask.agentId, second.id);
    assert.equal(secondTask.agentRevisionId, second.currentRevisionId);
    assert.equal(secondTask.providerId, 'magpie');
    assert.equal(secondTask.modelId, 'fixture/model-b');
    assert.match(prompts[1] ?? '', /Explain every step/);
    assert.match(prompts[1] ?? '', /Explain this\./);
    assert.equal(requestedModels[1], 'fixture/model-b');

    const queued = service.store.listEvents(null).find((event) => event.taskId === task.id);
    assert.equal(queued?.agentId, task.agentId);
    assert.equal(queued?.agentRevisionId, task.agentRevisionId);
    assert.equal(queued?.providerId, task.providerId);
    assert.equal(queued?.modelId, task.modelId);

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${first.id}`,
      payload: {
        expectedRevisionId: first.currentRevisionId,
        profile: {
          name: 'Agent A updated',
          instructions: 'Updated instructions.',
          providerId: 'magpie',
          modelId: 'fixture/model-a',
        },
      },
    });
    assert.equal(update.statusCode, 200);
    const updatedRevision = update.json<{ agent: { currentRevisionId: string } }>().agent.currentRevisionId;
    assert.notEqual(updatedRevision, first.currentRevisionId);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${first.id}`,
      payload: {
        expectedRevisionId: first.currentRevisionId,
        profile: {
          name: 'Stale', instructions: '', providerId: 'magpie', modelId: 'fixture/model-a',
        },
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json<{ error: string }>().error, new RegExp(updatedRevision));

    const invalidShape = await app.inject({
      method: 'POST', url: '/v1/tasks',
      payload: { prompt: 'bad mix', agentId: first.id, model: 'fixture/model-a' },
    });
    assert.equal(invalidShape.statusCode, 400);
    const ignoredOverride = await app.inject({
      method: 'POST', url: '/v1/tasks',
      payload: { prompt: 'bad override', modelOverride: { providerId: 'magpie', modelId: 'fixture/model-a' } },
    });
    assert.equal(ignoredOverride.statusCode, 400);

    const archived = await app.inject({ method: 'POST', url: `/v1/agents/${first.id}/archive` });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json<{ agent: { archived: boolean; isDefault: boolean } }>().agent.archived, true);
    assert.equal(archived.json<{ agent: { archived: boolean; isDefault: boolean } }>().agent.isDefault, false);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/agents/default' }))
      .json<{ agent: null }>().agent, null);
    const cannotStart = await app.inject({
      method: 'POST', url: '/v1/tasks', payload: { prompt: 'no', agentId: first.id },
    });
    assert.equal(cannotStart.statusCode, 409);
    assert.equal(service.store.getTask(task.id)?.agentRevisionId, first.currentRevisionId);
    assert.equal(service.getAgent(second.id).current.modelId, 'fixture/model-b');
    assert.equal(service.store.getTask(secondTask.id)?.agentRevisionId, second.currentRevisionId);

    const retry = await app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/retry` });
    assert.equal(retry.statusCode, 200);
    const retried = await service.waitForTask(task.id);
    assert.equal(retried.agentRevisionId, first.currentRevisionId);
    assert.equal(retried.providerId, 'magpie');
    assert.equal(retried.modelId, 'fixture/model-b');
    assert.match(prompts.at(-1) ?? '', /Use concise wording/);

    const v2Document = {
      schemaVersion: 2,
      name: 'v2 compatibility',
      skills: [], policies: [], mcpServers: [], plugins: [], secretRefs: [], metadata: {},
      composition: {
        schemaVersion: 1,
        name: 'global deterministic fixture',
        nodes: [{ id: 'node-a', label: 'First node' }],
        links: [],
        entryNodeIds: ['node-a'],
        metadata: {},
      },
    };
    const applyV2 = await app.inject({
      method: 'POST', url: '/v1/configuration/apply', payload: { document: v2Document },
    });
    assert.equal(applyV2.statusCode, 200);
    const v2RevisionId = applyV2.json<{ activeRevisionId: string }>().activeRevisionId;
    const agentTaskV2Response = await app.inject({
      method: 'POST', url: '/v1/tasks',
      payload: { prompt: 'Agent stays single turn.', agentId: second.id },
    });
    assert.equal(agentTaskV2Response.statusCode, 202);
    const agentTaskV2 = agentTaskV2Response.json<{ task: { id: string; configurationRevisionId: string } }>().task;
    await service.waitForTask(agentTaskV2.id);
    assert.equal(agentTaskV2.configurationRevisionId, v2RevisionId);
    assert.ok(service.store.listEvents(null).filter((event) => event.taskId === agentTaskV2.id)
      .every((event) => !event.type.startsWith('composition.')));
    assert.equal(requestedModels.at(-1), 'fixture/model-b');

    const legacyV2Response = await app.inject({
      method: 'POST', url: '/v1/tasks', payload: { prompt: 'Legacy remains v2.', model: 'fixture/model-a' },
    });
    assert.equal(legacyV2Response.statusCode, 202);
    const legacyV2 = legacyV2Response.json<{ task: { id: string; configurationRevisionId: string; agentId?: string } }>().task;
    await service.waitForTask(legacyV2.id);
    assert.equal(legacyV2.configurationRevisionId, v2RevisionId);
    assert.equal(legacyV2.agentId, undefined);
    assert.ok(service.store.listEvents(null).some((event) => event.taskId === legacyV2.id
      && event.type === 'composition.completed'));

    const unsupportedProvider = await app.inject({
      method: 'POST', url: '/v1/tasks', payload: {
        prompt: 'Do not silently fall back.', agentId: second.id,
        modelOverride: { providerId: 'alternate', modelId: 'fixture/model-a' },
      },
    });
    assert.equal(unsupportedProvider.statusCode, 400);
    assert.equal(service.store.listTasks().some((item) => item.prompt === 'Do not silently fall back.'), false);
  } finally {
    service.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
