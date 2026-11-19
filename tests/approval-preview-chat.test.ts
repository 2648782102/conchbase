import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import { createBuiltinWriteTools } from '../src/runtime/write-tools.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

const catalog: ModelCatalogClient = {
  async listModels() { return Object.freeze([{ id: 'fixture/model', displayName: 'F' }]); },
};

function toolCall(): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'c1', type: 'function',
      function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'notes/a.txt', content: 'hello' }) },
    }] } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

test('a waiting_approval message explains the change without an HTTP recipe', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-approve-preview-'));
  const read = createBuiltinReadTools({ root: directory });
  const write = createBuiltinWriteTools({ root: directory });
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'fixture/model', display_name: 'F' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return toolCall();
    }) as typeof globalThis.fetch,
  }, {
    tools: {
      list: () => [...read.list(), ...write.list()],
      has: (id) => read.has(id) || write.has(id),
      invoke: (id, args) => (read.has(id) ? read.invoke(id, args) : write.invoke(id, args)),
    },
  });
  const chat = new AgentChatService(service);
  try {
    const agent = await service.createAgent({
      name: '写入员', instructions: 'x', providerId: 'magpie', modelId: 'fixture/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_write' }],
    });
    const conversation = await chat.createConversation({ agentId: agent.id });
    await chat.postMessage(conversation.id, { text: '写文件', idempotencyKey: 'p1' });

    let view = chat.view(conversation.id);
    for (let attempt = 0; attempt < 200 && view.messages.at(-1)?.state !== 'waiting_approval'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      view = chat.view(conversation.id);
    }
    const message = view.messages.at(-1)!;
    assert.equal(message.state, 'waiting_approval');

    const body = message.body;
    assert.match(body, /需要你的批准/);
    assert.equal(body.includes('POST /v1/'), false, 'no HTTP recipe in user-facing text');
    assert.equal(body.includes('assistantMessageId'), false);

    // The change is described from Runtime-computed preview data.
    const labels = message.activity.map((entry) => `${entry.label} ${entry.detail ?? ''}`).join(' | ');
    assert.match(labels, /notes\/a\.txt/);
    assert.match(labels, /将要发生的改动/);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
