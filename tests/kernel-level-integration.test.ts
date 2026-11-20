import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';
import { createBuiltinWriteTools } from '../src/runtime/write-tools.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';

/**
 * The level has to change what actually happens, not just what a type allows.
 *
 * The policy unit tests prove the mapping; this proves the loop consults it.
 * A write that `standard` pauses for approval must run straight through under
 * `trusted`, with the same Agent, grants, and tool.
 */
async function runWrite(permissionLevel: 'standard' | 'trusted'): Promise<string | undefined> {
  const directory = mkdtempSync(path.join(tmpdir(), `conchbase-level-${permissionLevel}-`));
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const write = createBuiltinWriteTools({ root: workspace });
  const toolTurn = () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'c1', type: 'function',
      function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'a.txt', content: 'x', overwrite: true }) },
    }] } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const finalTurn = () => new Response(
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return String(init?.body ?? '').includes('"role":"tool"') ? finalTurn() : toolTurn();
  }) as typeof globalThis.fetch;
  const service = createTaskService(
    path.join(directory, 'runtime.sqlite'),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch, permissionLevel },
    { tools: { list: () => write.list(), has: write.has, invoke: write.invoke } },
  );
  try {
    const agent = await service.createAgent({
      name: 'writer', instructions: 'x', providerId: 'magpie', modelId: 'm',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_write' }] as never,
    });
    const task = await service.createAgentTask({ prompt: 'write', agentId: agent.id });
    service.startTask(task.id);
    // Give the loop time to reach either approval or completion.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const paused = service.store.getTask(task.id)?.state;
    if (paused === 'waiting_approval') {
      service.decideApproval(task.id, 'approved');
      await service.waitForTask(task.id);
      return 'paused';
    }
    await service.waitForTask(task.id);
    return paused;
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('standard pauses a workspace write for approval', async () => {
  assert.equal(await runWrite('standard'), 'paused');
});

test('trusted runs the same write without pausing', async () => {
  const outcome = await runWrite('trusted');
  assert.notEqual(outcome, 'paused', 'trusted must not pause for approval');
});

/**
 * `strict` exists for the case where even observing the workspace should be
 * confirmed. A read tool must therefore pause, and standard must not — the two
 * levels have to differ on the same tool.
 */
async function runRead(permissionLevel: 'strict' | 'standard'): Promise<string | undefined> {
  const directory = mkdtempSync(path.join(tmpdir(), `conchbase-read-${permissionLevel}-`));
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const read = createBuiltinReadTools({ root: workspace });
  const toolTurn = () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'c1', type: 'function',
      function: { name: 'workspace_list', arguments: JSON.stringify({ path: '.' }) },
    }] } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const finalTurn = () => new Response(
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return String(init?.body ?? '').includes('"role":"tool"') ? finalTurn() : toolTurn();
  }) as typeof globalThis.fetch;
  const service = createTaskService(
    path.join(directory, 'runtime.sqlite'),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch, permissionLevel },
    { tools: { list: () => read.list(), has: read.has, invoke: read.invoke } },
  );
  try {
    const agent = await service.createAgent({
      name: 'reader', instructions: 'x', providerId: 'magpie', modelId: 'm',
      grantedCapabilities: [{ kind: 'tool', name: 'workspace_list' }] as never,
    });
    const task = await service.createAgentTask({ prompt: 'look', agentId: agent.id });
    service.startTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const paused = service.store.getTask(task.id)?.state;
    if (paused === 'waiting_approval') {
      service.decideApproval(task.id, 'approved');
      await service.waitForTask(task.id);
      return 'paused';
    }
    await service.waitForTask(task.id);
    return paused;
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('strict pauses even a read for approval', async () => {
  assert.equal(await runRead('strict'), 'paused');
});

test('standard does not pause a read', async () => {
  assert.notEqual(await runRead('standard'), 'paused');
});
