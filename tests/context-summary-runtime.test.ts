import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';
import type { ProviderMessage } from '../src/runtime/model-adapter.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

/**
 * Trimming without summarising loses the earlier work.
 *
 * A reply that dropped the first ten turns could still answer, but it answered
 * as if the conversation had just started. This asserts the facts survive: the
 * dropped history is compressed and re-injected as labelled recollection.
 */
function smallWindowCatalog(): ModelCatalogClient {
  return {
    async listModels() {
      return [{ id: 'fixture/small', displayName: 'Small', contextTokens: 4_000, supportsTools: true }];
    },
  };
}

function bigReadTool(): ToolProvider {
  const body = 'y'.repeat(20_000);
  return {
    has: (toolId: string) => toolId === 'workspace_read',
    list: () => [{
      id: 'workspace_read',
      version: 1 as const,
      description: 'read',
      sideEffect: 'read' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
    }],
    invoke: () => ({ ok: true, summary: body, digest: 'sha256:fixture', bytes: body.length, evidence: { facts: {} } }),
  } as unknown as ToolProvider;
}

test('a trimmed prompt carries a summary of what it dropped', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-summary-runtime-'));
  const prompts: (readonly ProviderMessage[])[] = [];
  let turn = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: readonly ProviderMessage[] };
    prompts.push(body.messages ?? []);
    turn += 1;
    if (turn < 4) {
      return new Response(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{
          index: 0, id: `call_${turn}`, type: 'function',
          function: { name: 'workspace_read', arguments: '{}' },
        }] }, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '完成' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  let summaries = 0;
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/small',
      fetch: fetchImpl,
      loopBudget: { maxIterations: 8, maxToolCallsPerTurn: 4, deadlineMs: 60_000 },
    },
    smallWindowCatalog(),
    {
      tools: bigReadTool(),
      summarizer: async () => {
        summaries += 1;
        return '用户要求读取文件三次；前两次已读取成功，内容略。';
      },
    },
  );
  try {
    const agent = await service.createAgent({
      name: '摘要员', instructions: 'Read the file.', providerId: 'magpie', modelId: 'fixture/small',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const task = await service.createAgentTask({ prompt: '读三次并总结', agentId: agent.id });
    service.startTask(task.id);
    const finished = await service.waitForTask(task.id);
    assert.equal(finished.state, 'succeeded', finished.error ?? undefined);
    assert.ok(summaries > 0, 'the runtime must have summarised the dropped history');

    const withSummary = prompts.some((messages) =>
      messages.some((message) => message.role === 'system' && /摘要/.test(message.content) && /读取文件三次/.test(message.content)));
    assert.ok(withSummary, 'the summary must reach the model');

    const events = service.store.listTaskEvents(task.id);
    const trim = events.find((event) => event.type === 'agent_loop.context_trimmed');
    assert.ok(trim, 'the trim is still recorded');
    assert.equal((trim!.data as { summarized?: boolean }).summarized, true, 'and reports that it was summarised');
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('without a summariser the trim still works and says it was not summarised', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-summary-off-'));
  let turn = 0;
  const fetchImpl = (async () => {
    turn += 1;
    if (turn < 4) {
      return new Response(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{
          index: 0, id: `call_${turn}`, type: 'function',
          function: { name: 'workspace_read', arguments: '{}' },
        }] }, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '完成' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/small',
      fetch: fetchImpl,
      loopBudget: { maxIterations: 8, maxToolCallsPerTurn: 4, deadlineMs: 60_000 },
    },
    smallWindowCatalog(),
    { tools: bigReadTool() },
  );
  try {
    const agent = await service.createAgent({
      name: '无摘要', instructions: 'Read.', providerId: 'magpie', modelId: 'fixture/small',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const task = await service.createAgentTask({ prompt: '读三次', agentId: agent.id });
    service.startTask(task.id);
    const finished = await service.waitForTask(task.id);
    assert.equal(finished.state, 'succeeded');
    const trim = service.store.listTaskEvents(task.id)
      .find((event) => event.type === 'agent_loop.context_trimmed');
    assert.equal((trim!.data as { summarized?: boolean }).summarized, false);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
