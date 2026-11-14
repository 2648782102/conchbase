import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools, type ToolProvider } from '../src/runtime/tool-provider.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

function sseToolCall(name: string, args: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_fixture',
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\ndata: [DONE]\n\n`;
}

interface Turn {
  readonly text?: string;
  readonly tool?: { readonly name: string; readonly args: Record<string, unknown> };
}

function scriptedFetch(turns: readonly Turn[]): typeof globalThis.fetch {
  let index = 0;
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages?: readonly unknown[];
      tools?: readonly { readonly function?: { readonly name?: string } }[];
    };
    const turn = turns[Math.min(index, turns.length - 1)]!;
    index += 1;
    assert.ok(Array.isArray(body.messages));
    assert.ok(Array.isArray(body.tools));
    assert.ok(body.tools.some((tool) => tool.function?.name === 'workspace_read'));
    if (turn.tool) {
      return new Response(sseToolCall(turn.tool.name, turn.tool.args), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(sse(turn.text ?? 'done'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
}

function withService(
  turns: readonly Turn[],
  tools: ToolProvider,
  run: (service: TaskService, agentId: string) => Promise<void>,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-loop-'));
  const service = new TaskService(new SqliteTaskStore(path.join(directory, 'runtime.sqlite')), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: scriptedFetch(turns),
  }, catalogStub(), { tools });
  return service.createAgent({
    name: '循环测试员',
    instructions: 'Use tools when helpful.',
    providerId: 'magpie',
    modelId: 'fixture/model',
  }).then((agent) => run(service, agent.id)).finally(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

function catalogStub(): ModelCatalogClient {
  return {
    async listModels() {
      return Object.freeze([{ id: 'fixture/model', displayName: 'Fixture Model' }]);
    },
  };
}

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-workspace-'));
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'a.txt'), 'alpha line\nbeta line\n');
  writeFileSync(path.join(root, 'secret.txt'), 'outside');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a task loops from a tool result back to a final answer', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    await withService([
      { tool: { name: 'workspace_list', args: { path: 'notes' } } },
      { text: '找到 a.txt。' },
    ], tools, async (service, agentId) => {
      const created = await service.createAgentTask({ prompt: '列出 notes 目录', agentId });
      service.startTask(created.id);
      const task = await service.waitForTask(created.id);
      assert.equal(task.state, 'succeeded');
      assert.equal(task.output, '找到 a.txt。');
      const types = service.store.listEvents(null).map((event) => event.type);
      assert.ok(types.includes('agent_loop.tool_executed' as never));
      assert.ok(types.includes('agent_loop.turn_completed' as never));
    });
  } finally {
    space.cleanup();
  }
});

test('the loop stops at its iteration budget instead of spinning', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    await withService([
      { tool: { name: 'workspace_list', args: { path: 'notes' } } },
    ], tools, async (service, agentId) => {
      const created = await service.createAgentTask({ prompt: 'loop', agentId });
      service.startTask(created.id);
      const task = await service.waitForTask(created.id);
      assert.equal(task.state, 'failed');
      assert.match(task.error ?? '', /iteration|budget/i);
    });
  } finally {
    space.cleanup();
  }
});

test('a path outside the workspace root is denied and reported to the model', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    await withService([
      { tool: { name: 'workspace_read', args: { path: '../etc/passwd' } } },
      { text: '无法读取。' },
    ], tools, async (service, agentId) => {
      const created = await service.createAgentTask({ prompt: 'read outside', agentId });
      service.startTask(created.id);
      const task = await service.waitForTask(created.id);
      assert.equal(task.state, 'succeeded');
      const failed = service.store.listEvents(null).filter((event) => event.type === ('agent_loop.tool_failed' as never));
      assert.equal(failed.length, 1);
      assert.doesNotMatch(JSON.stringify(failed), /passwd|outside/);
    });
  } finally {
    space.cleanup();
  }
});

test('a write-capable tool is not registered in v1', async () => {
  const space = workspace();
  const tools = createBuiltinReadTools({ root: space.root });
  try {
    const ids = tools.list().map((tool) => tool.id);
    assert.deepEqual(ids, ['text_search', 'workspace_list', 'workspace_read']);
    assert.ok(tools.list().every((tool) => tool.sideEffect === 'read'));
  } finally {
    space.cleanup();
  }
});
