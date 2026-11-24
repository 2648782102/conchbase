import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';
import type { ProviderMessage, ProviderToolDefinition } from '../src/runtime/model-adapter.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

/**
 * The budget has to act on the real prompt, not only in a pure function.
 *
 * The failure this guards against was invisible to unit tests: the loop built a
 * prompt, appended a tool result per iteration, and never measured any of it.
 * The model rejected the turn and the user saw "model failed" — after the work
 * had already run.
 */
function catalogWithWindow(contextTokens: number): ModelCatalogClient {
  return {
    async listModels() {
      return [{ id: 'fixture/small', displayName: 'Small', contextTokens, supportsTools: true }];
    },
  };
}

function bigResultTool(): ToolProvider {
  const body = 'x'.repeat(40_000);
  return {
    id: 'fixture-tools',
    has: (toolId: string) => toolId === 'workspace_read',
    list: () => [
      {
        id: 'workspace_read',
        version: 1 as const,
        description: 'read a file',
        sideEffect: 'read' as const,
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    ],
    // Larger than the whole window, so the run can only finish by trimming.
    invoke: () => ({ ok: true, summary: body, digest: 'sha256:fixture', bytes: body.length, evidence: { facts: {} } }),
  } as unknown as ToolProvider;
}

test('a long tool chain trims to the model window and still finishes', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-budget-runtime-'));
  const seen: { promptMessages: number; promptTokensEstimate: number }[] = [];
  let turn = 0;
  const fetchImpl = (async () => {
    turn += 1;
    if (turn < 4) {
      // The provider streams; a plain JSON tool-call body is rejected as an
      // invalid frame, which is what this fixture got wrong first.
      return new Response(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_${turn}`,
              type: 'function',
              function: { name: 'workspace_read', arguments: '{}' },
            }],
          },
          finish_reason: null,
        }],
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
    catalogWithWindow(4_000),
    { tools: bigResultTool() },
  );
  try {
    const agent = await service.createAgent({
      name: '预算员', instructions: 'Use the tool.', providerId: 'magpie', modelId: 'fixture/small',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const task = await service.createAgentTask({ prompt: '读三次文件并总结', agentId: agent.id });
    service.startTask(task.id);
    const finished = await service.waitForTask(task.id);

    assert.equal(finished.state, 'succeeded', `expected success, got ${finished.state}: ${finished.error}`);
    const trimmed = service.store.listTaskEvents(task.id)
      .filter((event) => event.type === 'agent_loop.context_trimmed');
    if (trimmed.length === 0) {
      const types = service.store.listTaskEvents(task.id).map((event) => event.type);
      assert.fail(`no trim event; events: ${types.join(',')}`);
    }
    const data = trimmed[0]!.data as { droppedTokens?: number; budgetTokens?: number };
    assert.ok((data.droppedTokens ?? 0) > 0);
    assert.ok((data.budgetTokens ?? 0) > 0);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('trimmed tool turns keep every tool result paired with its call', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-budget-pairs-'));
  const prompts: (readonly Record<string, unknown>[])[] = [];
  let turn = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: readonly ProviderMessage[] };
    prompts.push((body.messages ?? []) as readonly Record<string, unknown>[]);
    turn += 1;
    if (turn < 6) {
      return new Response(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_${turn}`,
              type: 'function',
              function: { name: 'workspace_read', arguments: '{}' },
            }],
          },
          finish_reason: null,
        }],
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
    catalogWithWindow(4_000),
    { tools: bigResultTool() },
  );
  try {
    const agent = await service.createAgent({
      name: '协议员', instructions: 'Use tools.', providerId: 'magpie', modelId: 'fixture/small',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const task = await service.createAgentTask({ prompt: 'read six times', agentId: agent.id });
    service.startTask(task.id);
    const finished = await service.waitForTask(task.id);
    assert.equal(finished.state, 'succeeded', finished.error ?? '');
    assert.ok(prompts.length >= 6);
    for (const messages of prompts) {
      const callIds = new Set<string>();
      for (const message of messages) {
        if (message.role !== 'assistant') continue;
        const calls = message.tool_calls as readonly { id?: unknown }[] | undefined;
        for (const call of calls ?? []) {
          if (typeof call.id === 'string') callIds.add(call.id);
        }
      }
      for (const message of messages) {
        if (message.role === 'tool') {
          const callId = message.tool_call_id;
          assert.ok(typeof callId === 'string' && callIds.has(callId), `orphaned tool result: ${String(callId)}`);
        }
      }
    }
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
