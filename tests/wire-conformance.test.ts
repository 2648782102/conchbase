import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

/**
 * Wire-format conformance.
 *
 * Every other test in this repository injects a fake `fetch`, so the request
 * body never leaves the process and an internal shape can silently reach the
 * wire. That is exactly how a `toolCallId` leak survived a fully green suite.
 *
 * This fixture starts a real HTTP server, speaks OpenAI Chat Completions over
 * the socket, and **rejects any request body that is not wire-valid**. A
 * regression in the translation layer fails here instead of in a live session.
 */

interface WireMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: unknown;
  readonly toolCallId?: unknown;
  readonly toolCalls?: unknown;
}

function assertWireValid(body: Record<string, unknown>, _seen?: { turns: number }): void {
  assert.equal(typeof body.model, 'string', 'model must be a string');
  assert.ok(Array.isArray(body.messages), 'messages must be an array');
  for (const [index, raw] of (body.messages as WireMessage[]).entries()) {
    const where = `messages[${index}]`;
    assert.equal(raw.toolCallId, undefined, `${where} leaked the internal toolCallId`);
    assert.equal(raw.toolCalls, undefined, `${where} leaked the internal toolCalls`);
    switch (raw.role) {
      case 'system':
      case 'user':
        assert.equal(typeof raw.content, 'string', `${where}.content must be a string`);
        break;
      case 'assistant':
        assert.equal(typeof raw.content, 'string', `${where}.content must be a string`);
        if (raw.tool_calls !== undefined) {
          assert.ok(Array.isArray(raw.tool_calls), `${where}.tool_calls must be an array`);
          for (const [callIndex, call] of (raw.tool_calls as Record<string, unknown>[]).entries()) {
            assert.equal(call.type, 'function', `${where}.tool_calls[${callIndex}].type must be "function"`);
            assert.equal(typeof call.id, 'string', `${where}.tool_calls[${callIndex}].id must be a string`);
            const fn = call.function as Record<string, unknown> | undefined;
            assert.ok(fn, `${where}.tool_calls[${callIndex}].function is required`);
            assert.equal(typeof fn!.name, 'string', `${where}.tool_calls[${callIndex}].function.name`);
            assert.equal(
              typeof fn!.arguments,
              'string',
              `${where}.tool_calls[${callIndex}].function.arguments must be a JSON string`,
            );
          }
        }
        break;
      case 'tool':
        assert.equal(typeof raw.tool_call_id, 'string', `${where}.tool_call_id is required`);
        assert.equal(typeof raw.content, 'string', `${where}.content must be a string`);
        break;
      default:
        assert.fail(`${where}.role "${String(raw.role)}" is not a wire role`);
    }
  }
  if (body.tools !== undefined) {
    assert.ok(Array.isArray(body.tools), 'tools must be an array');
    for (const tool of body.tools as Record<string, unknown>[]) {
      assert.equal(tool.type, 'function', 'tools[].type must be "function"');
      const fn = tool.function as Record<string, unknown> | undefined;
      assert.equal(typeof fn?.name, 'string', 'tools[].function.name');
      assert.equal(typeof fn?.description, 'string', 'tools[].function.description');
      assert.equal(typeof fn?.parameters, 'object', 'tools[].function.parameters');
    }
  }

}

function sse(frames: readonly string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n';
}

function toolCallFrame(id: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: null,
    }],
  });
}

function textFrame(content: string): string {
  return JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] });
}

interface Fixture {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly turns: { count: number };
}

/**
 * A strictly wire-shaped OpenAI-compatible server. It replies with a tool call
 * on the first turn and a final answer on the second, which is the minimum
 * shape that exercises request translation in both directions.
 */
async function startWireServer(): Promise<Fixture> {
  const turns = { count: 0 };
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { raw += chunk; });
    request.on('end', () => {
      if (request.url?.endsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'wire/model', display_name: 'Wire Model' }] }));
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'request body was not JSON' }));
        return;
      }
      try {
        assertWireValid(body);
      } catch (cause) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: cause instanceof Error ? cause.message : 'wire violation' }));
        return;
      }
      turns.count += 1;
      const frames = turns.count === 1
        ? [toolCallFrame('call_wire_1', 'workspace_read', { path: 'note.txt' })]
        : [textFrame('文件内容是 alpha。')];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse(frames));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('wire server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    turns,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function catalog(): ModelCatalogClient {
  return {
    async listModels() {
      return Object.freeze([{ id: 'wire/model', displayName: 'Wire Model' }]);
    },
  };
}

test('a full agent loop keeps every request wire-valid over a real socket', async () => {
  const fixture = await startWireServer();
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-wire-'));
  writeFileSync(path.join(directory, 'note.txt'), 'alpha\n');
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: fixture.baseUrl,
      defaultModel: 'wire/model',
      executionMode: 'restricted',
      loopBudget: { maxIterations: 6, maxToolCallsPerTurn: 4, deadlineMs: 30_000 },
    },
    catalog(),
    { tools: createBuiltinReadTools({ root: directory }) },
  );
  try {
    const agent = await service.createAgent({
      name: '线上格式检查员',
      instructions: 'Read the file, then answer.',
      providerId: 'magpie',
      modelId: 'wire/model',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_read' }],
    });
    const created = await service.createAgentTask({ prompt: '读取 note.txt', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);

    assert.equal(task.state, 'succeeded', task.error ?? 'task failed');
    assert.equal(fixture.turns.count, 2, 'the loop must make exactly two provider turns');
    assert.equal(task.output, '文件内容是 alpha。');

    const events = service.store.listEvents(null).filter((event) => event.taskId === created.id);
    assert.ok(
      events.some((event) => event.type === 'agent_loop.tool_executed'),
      'the tool must actually execute',
    );
  } finally {
    service.close();
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wire violations are reported instead of silently accepted', async () => {
  // Guards the guard: if the fixture stopped checking, this test would pass a
  // camelCase body and the whole suite would go quiet again.
  const seen = { turns: 0 };
  assert.throws(
    () => assertWireValid({
      model: 'wire/model',
      messages: [{ role: 'tool', toolCallId: 'call_1', content: 'x' }],
    }),
    /leaked the internal toolCallId/,
  );
  assert.throws(
    () => assertWireValid({
      model: 'wire/model',
      messages: [{ role: 'assistant', content: '', toolCalls: [] }],
    }),
    /leaked the internal toolCalls/,
  );
  assert.throws(
    () => assertWireValid({
      model: 'wire/model',
      messages: [{
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: {} } }],
      }],
    }),
    /function\.arguments must be a JSON string/,
  );
});
