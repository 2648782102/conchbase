import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SqliteTaskStore } from '../../src/runtime/task-store.js';
import { TaskService } from '../../src/runtime/task-service.js';
import { createBuiltinReadTools } from '../../src/runtime/tool-provider.js';
import { createBuiltinWriteTools } from '../../src/runtime/write-tools.js';
import { combineToolProviders, type ToolProvider } from '../../src/runtime/tool-provider.js';
import type { ModelCatalogClient } from '../../src/runtime/model-catalog.js';
import type { ExecutionMode } from '../../src/config/runtime-config.js';

/**
 * Scenario harness for agent behaviour.
 *
 * Unit tests answer "does this function return the right value". An agent has
 * no single return value: it decides, calls tools, observes, retries, and
 * eventually claims something. The properties worth testing are about the
 * trace and the artefact, not one call:
 *
 *  - did it actually read before asserting?
 *  - did it stop when it should?
 *  - did it stay inside its grant?
 *  - is the workspace in the state it claimed?
 */

export type ScriptedTurn =
  | { readonly kind: 'final'; readonly text: string }
  | {
    readonly kind: 'tools';
    readonly text?: string;
    readonly calls: readonly {
      readonly name: string;
      readonly args: Record<string, unknown>;
      readonly id?: string;
    }[];
  };

export interface ScenarioOptions {
  readonly prompt: string;
  readonly turns: readonly ScriptedTurn[];
  readonly executionMode?: ExecutionMode;
  readonly allowWrites?: boolean;
  readonly maxIterations?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly deadlineMs?: number;
  readonly files?: Readonly<Record<string, string>>;
  readonly extraTools?: ToolProvider;
}

export interface ScenarioRun {
  readonly taskId: string;
  readonly state: string;
  readonly output: string | null;
  readonly error: string | null;
  readonly requests: readonly unknown[];
  readonly toolCallsSeen: readonly { readonly name: string; readonly args: string }[];
  readonly events: readonly { readonly type: string; readonly data: Record<string, unknown> }[];
  readonly workspace: string;
  read(relativePath: string): string | null;
  list(relativePath?: string): readonly string[];
  assertFiles(expected: readonly string[]): void;
  toolSequence(): readonly string[];
  cleanup(): void;
}

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

function sseTools(
  text: string,
  calls: readonly { name: string; args: Record<string, unknown>; id?: string }[],
): string {
  const deltas = calls.map((call, index) => ({
    index,
    id: call.id ?? `call_${index}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text, tool_calls: deltas }, finish_reason: null }],
  })}\n\ndata: [DONE]\n\n`;
}

const catalog: ModelCatalogClient = {
  async listModels() {
    return [{ id: 'scenario/model', displayName: 'Scenario Model' }];
  },
};

function walk(root: string, relative = ''): string[] {
  const current = path.join(root, relative);
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, next));
    else files.push(next);
  }
  return files.sort();
}

export async function runScenario(options: ScenarioOptions): Promise<ScenarioRun> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-scenario-'));
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const target = path.join(workspace, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const requests: unknown[] = [];
  const toolCallsSeen: { name: string; args: string }[] = [];
  let turnIndex = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'scenario/model', display_name: 'Scenario Model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push(body);
    for (const message of (body.messages ?? []) as Record<string, unknown>[]) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls as Record<string, unknown>[]) {
          const fn = call.function as { name?: string; arguments?: string } | undefined;
          if (fn?.name) toolCallsSeen.push({ name: fn.name, args: String(fn.arguments ?? '') });
        }
      }
    }
    const turn = options.turns[Math.min(turnIndex, options.turns.length - 1)];
    turnIndex += 1;
    if (!turn) throw new Error('scenario has no scripted turns');
    return new Response(
      turn.kind === 'final' ? sse(turn.text) : sseTools(turn.text ?? '', turn.calls),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const providers: ToolProvider[] = [createBuiltinReadTools({ root: workspace })];
  if (options.allowWrites) providers.push(createBuiltinWriteTools({ root: workspace }));
  if (options.extraTools) providers.push(options.extraTools);

  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  const service = new TaskService(store, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'scenario/model',
    fetch: fetchImpl,
    executionMode: options.executionMode ?? 'unrestricted',
    loopBudget: {
      maxIterations: options.maxIterations ?? 6,
      maxToolCallsPerTurn: options.maxToolCallsPerTurn ?? 4,
      deadlineMs: options.deadlineMs ?? 30_000,
    },
  }, catalog, { tools: combineToolProviders(providers) });

  // A scenario exercises an *Agent*, so it must be an Agent-backed task: tools
  // and Skills reach the model only through the pinned Agent revision's grants.
  // Using a bare task silently gave the model no tools at all.
  const granted = (options.extraTools ? options.extraTools.list() : providers.flatMap((provider) => provider.list()))
    .map((tool) => ({ kind: 'tool' as const, name: tool.id }));
  const agent = await service.createAgent({
    name: '场景测试员工',
    instructions: 'Use the available tools when they help.',
    providerId: 'magpie',
    modelId: 'scenario/model',
    grantedCapabilities: granted,
  });
  const task = store.createAgentTask({
    id: `task_scenario_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    prompt: options.prompt,
    agentId: agent.id,
    expectedAgentRevisionId: agent.currentRevisionId,
  });

  service.startTask(task.id);
  const finished = await service.waitForTask(task.id);
  const events = store.listTaskEvents(task.id).map((event) => ({
    type: event.type,
    data: event.data as Record<string, unknown>,
  }));

  return {
    taskId: task.id,
    state: finished.state,
    output: finished.output,
    error: finished.error,
    requests,
    toolCallsSeen,
    events,
    workspace,
    read: (relativePath) => {
      const target = path.join(workspace, relativePath);
      return existsSync(target) ? readFileSync(target, 'utf8') : null;
    },
    list: (relativePath = '') => walk(workspace, relativePath),
    assertFiles: (expected) => {
      const actual = walk(workspace);
      assert.deepEqual(actual, [...expected].sort(), `workspace files:\n${actual.join('\n')}`);
    },
    toolSequence: () => events
      .filter((event) => event.type.startsWith('agent_loop.tool'))
      .map((event) => String(event.data.toolId ?? event.data.tool ?? 'unknown')),
    cleanup: () => {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function readThenAnswer(file: string, answer: string): readonly ScriptedTurn[] {
  return [
    { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: file } }] },
    { kind: 'final', text: answer },
  ];
}
