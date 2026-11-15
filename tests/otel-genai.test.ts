import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OTEL_GENAI_ATTRIBUTES,
  flattenOtelAttributes,
  otelGenAiAttributes,
} from '../src/runtime/otel-genai.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';

function catalog(): ModelCatalogClient {
  return {
    async listModels() {
      return Object.freeze([{ id: 'fixture/model', displayName: 'Fixture' }]);
    },
  };
}

test('attribute names match the published OTel GenAI convention', () => {
  assert.equal(OTEL_GENAI_ATTRIBUTES.providerName, 'gen_ai.provider.name');
  assert.equal(OTEL_GENAI_ATTRIBUTES.requestModel, 'gen_ai.request.model');
  assert.equal(OTEL_GENAI_ATTRIBUTES.agentName, 'gen_ai.agent.name');
  assert.equal(OTEL_GENAI_ATTRIBUTES.toolName, 'gen_ai.tool.name');
});

test('attributes are built only from known context and flattened with a namespace', () => {
  const attributes = otelGenAiAttributes({
    providerId: 'magpie',
    modelId: 'fixture/model',
    agentId: 'agt_x',
    agentName: '研究员',
  }, { [OTEL_GENAI_ATTRIBUTES.operationName]: 'invoke_agent' });

  const flattened = flattenOtelAttributes(attributes);
  assert.equal(flattened['otel.gen_ai.provider.name'], 'magpie');
  assert.equal(flattened['otel.gen_ai.request.model'], 'fixture/model');
  assert.equal(flattened['otel.gen_ai.agent.name'], '研究员');
  assert.equal(flattened['otel.gen_ai.operation.name'], 'invoke_agent');
});

test('absent context produces no empty attributes', () => {
  assert.deepEqual(flattenOtelAttributes(otelGenAiAttributes({})), {});
});

test('durable task events carry the additive otel block without changing existing fields', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-otel-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: (async () => new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as typeof globalThis.fetch,
    },
    catalog(),
    // An Agent-backed task only enters the Agent loop when a tool provider is
    // configured; the loop is where the instrumented events are emitted.
    { tools: createBuiltinReadTools({ root: directory }) },
  );
  try {
    const agent = await service.createAgent({
      name: '可观测员',
      instructions: 'Be brief.',
      providerId: 'magpie',
      modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'hello', agentId: agent.id });
    service.startTask(created.id);
    await service.waitForTask(created.id);

    const events = service.store.listEvents(null).filter((event) => event.taskId === created.id);
    // Agent-loop and task-transition events written through TaskService carry
    // the attributes. Some bootstrap rows (task.queued) are inserted by the
    // store directly and are out of scope for this additive field.
    const instrumented = events.filter((event) => event.type.startsWith('agent_loop.'));
    assert.ok(instrumented.length > 0, 'the task must produce agent_loop events');
    for (const event of instrumented) {
      assert.equal(event.data['otel.gen_ai.provider.name'], 'magpie', event.type);
      assert.equal(event.data['otel.gen_ai.request.model'], 'fixture/model', event.type);
      assert.equal(event.data['otel.gen_ai.agent.name'], '可观测员', event.type);
      assert.equal(event.data['otel.gen_ai.operation.name'], 'invoke_agent', event.type);
      // Existing identity fields stay on the event envelope, unchanged.
      assert.equal(event.providerId, 'magpie');
      assert.equal(event.modelId, 'fixture/model');
    }
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
