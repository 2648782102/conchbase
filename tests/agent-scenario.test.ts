import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './support/agent-scenario.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

/**
 * Agent behaviour scenarios.
 *
 * These assert on the trace and the artefact, not on a return value: what the
 * model was allowed to see, whether it read before asserting, whether it
 * stopped, and whether the workspace matches what it claimed.
 */

test('the agent answers from file content it actually read', async () => {
  const run = await runScenario({
    prompt: '统计 notes.txt 的行数并说明内容',
    files: { 'notes.txt': 'alpha\nbeta\ngamma\n' },
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: 'notes.txt' } }] },
      { kind: 'final', text: '3 行：alpha / beta / gamma。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    // The decisive property: the tool result reached the model's context.
    const lastRequest = JSON.stringify(run.requests.at(-1));
    assert.match(lastRequest, /alpha/, 'the read result must be visible to the model');
    assert.match(lastRequest, /gamma/);
    // And the trace shows a real execution, not a claim.
    assert.ok(run.events.some((event) => event.type === 'agent_loop.tool_executed'));
  } finally {
    run.cleanup();
  }
});

test('a write tool produces the claimed file with the claimed content', async () => {
  const run = await runScenario({
    prompt: '创建 out.txt，内容为 done',
    allowWrites: true,
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_write', args: { path: 'out.txt', content: 'done' } }] },
      { kind: 'final', text: '已写入 out.txt。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    // The claim is verified against the filesystem, not trusted.
    assert.equal(run.read('out.txt'), 'done');
    run.assertFiles(['out.txt']);
  } finally {
    run.cleanup();
  }
});

test('without a write grant the agent cannot create files', async () => {
  const run = await runScenario({
    prompt: '创建 out.txt',
    // Reads only: the write tool is not registered at all.
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_write', args: { path: 'out.txt', content: 'x' } }] },
      { kind: 'final', text: '无法写入。' },
    ],
  });
  try {
    // Either the call is rejected or the model never gets the tool; both mean
    // the file must not exist. The invariant is the filesystem, not the error.
    assert.equal(run.read('out.txt'), null, 'no write grant means no file');
  } finally {
    run.cleanup();
  }
});

test('an unread file is never asserted as fact', async () => {
  // Negative scenario: the model claims a number without reading. The Runtime
  // cannot detect a lie, but the test can prove the claim had no evidence,
  // which is exactly the behaviour we want to keep visible.
  const run = await runScenario({
    prompt: 'secret.txt 里写了什么？',
    files: { 'secret.txt': 'PRIVATE-CONTENT' },
    turns: [{ kind: 'final', text: '内容是 hello。' }],
  });
  try {
    assert.equal(run.state, 'succeeded');
    const firstRequest = JSON.stringify(run.requests[0]);
    assert.doesNotMatch(firstRequest, /PRIVATE-CONTENT/, 'the file content was never in context');
    assert.ok(!run.events.some((event) => event.type === 'agent_loop.tool_executed'),
      'no tool ran, so the answer has no evidence');
  } finally {
    run.cleanup();
  }
});

test('a path outside the workspace is rejected rather than read', async () => {
  const run = await runScenario({
    prompt: '读取 ../../etc/passwd',
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: '../../etc/passwd' } }] },
      { kind: 'final', text: '无法读取。' },
    ],
  });
  try {
    // The escape must surface as a failed tool call, and the model must never
    // receive host file content.
    const allRequests = JSON.stringify(run.requests);
    assert.doesNotMatch(allRequests, /root:/, 'host file content must never reach the model');
    // The escape is recorded as an explicit failure, not a silent drop and not
    // a successful read.
    const failed = run.events.find((event) => event.type === 'agent_loop.tool_failed');
    assert.ok(failed, 'the attempted escape is recorded');
    assert.equal(failed!.data.errorCode, 'path_escapes_root');
    assert.ok(!run.events.some((event) => event.type === 'agent_loop.tool_executed'),
      'a traversal must never be reported as an executed read');
  } finally {
    run.cleanup();
  }
});

test('the loop stops at its iteration budget instead of running forever', async () => {
  // A model that keeps calling tools must be cut off deterministically.
  const run = await runScenario({
    prompt: '无限读取',
    files: { 'a.txt': 'x' },
    maxIterations: 3,
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: 'a.txt' } }] },
    ],
  });
  try {
    assert.equal(run.state, 'failed', 'a non-terminating loop must fail, not hang');
    assert.match(run.error ?? '', /iterations/i);
    // It must have stopped at the budget, not spun.
    assert.ok(run.requests.length <= 3, `expected at most 3 model calls, saw ${run.requests.length}`);
  } finally {
    run.cleanup();
  }
});

test('the per-turn tool cap rejects an oversized batch', async () => {
  const run = await runScenario({
    prompt: '一次调用很多工具',
    files: { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3', 'd.txt': '4', 'e.txt': '5' },
    maxToolCallsPerTurn: 2,
    turns: [
      {
        kind: 'tools',
        calls: ['a.txt', 'b.txt', 'c.txt'].map((file) => ({
          name: 'workspace_read', args: { path: file },
        })),
      },
      { kind: 'final', text: 'done' },
    ],
  });
  try {
    assert.equal(run.state, 'failed');
    assert.match(run.error ?? '', /at most 2 tool calls/i);
  } finally {
    run.cleanup();
  }
});

test('the agent reflects a tool failure instead of inventing success', async () => {
  const failingTool: ToolProvider = {
    list: () => [{ id: 'flaky_lookup', version: 1, description: 'always fails', sideEffect: 'read' }],
    has: (id) => id === 'flaky_lookup',
    invoke: () => { throw new Error('upstream unavailable'); },
  };
  const run = await runScenario({
    prompt: '查询数据',
    extraTools: failingTool,
    turns: [
      { kind: 'tools', calls: [{ name: 'flaky_lookup', args: {} }] },
      { kind: 'final', text: '查询失败：上游不可用。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    // The failure text must have been shown to the model so it can report it.
    const lastRequest = JSON.stringify(run.requests.at(-1));
    assert.match(lastRequest, /upstream unavailable|failed/i);
  } finally {
    run.cleanup();
  }
});

test('a final answer with no tool use completes in one turn', async () => {
  const run = await runScenario({
    prompt: '打个招呼',
    turns: [{ kind: 'final', text: '你好。' }],
  });
  try {
    assert.equal(run.state, 'succeeded');
    assert.equal(run.output, '你好。');
    assert.equal(run.requests.length, 1, 'a direct answer needs exactly one model call');
    assert.ok(!run.events.some((event) => event.type === 'agent_loop.tool_executed'));
  } finally {
    run.cleanup();
  }
});

test('the runtime records every tool execution durably', async () => {
  const run = await runScenario({
    prompt: '读取两个文件',
    files: { 'a.txt': 'one', 'b.txt': 'two' },
    turns: [
      {
        kind: 'tools',
        calls: [
          { name: 'workspace_read', args: { path: 'a.txt' } },
          { name: 'workspace_read', args: { path: 'b.txt' } },
        ],
      },
      { kind: 'final', text: '都读到了。' },
    ],
  });
  try {
    const executed = run.events.filter((event) => event.type === 'agent_loop.tool_executed');
    assert.equal(executed.length, 2, 'each call gets its own durable record');
    for (const event of executed) {
      assert.equal(typeof event.data.toolId, 'string');
      // Digests, not raw arguments or results: the durable trace must not carry
      // file content or anything a model supplied verbatim.
      assert.match(String(event.data.argumentsDigest), /^arg_/);
      assert.match(String(event.data.resultDigest), /^sha256:/);
    }
  } finally {
    run.cleanup();
  }
});

test('a nested workspace directory is readable but traversal is not', async () => {
  const run = await runScenario({
    prompt: '读取子目录文件',
    files: { 'docs/guide.md': '# 指南\n内容在此' },
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: 'docs/guide.md' } }] },
      { kind: 'final', text: '已读取指南。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    const lastRequest = JSON.stringify(run.requests.at(-1));
    assert.match(lastRequest, /内容在此/, 'a nested file inside the root is allowed');
  } finally {
    run.cleanup();
  }
});

/**
 * Multi-step reasoning.
 *
 * The point of these is not that the model is smart — it is scripted — but that
 * the Runtime correctly carries *state* between steps: what was read, what was
 * written, and what the model was shown when it made each decision.
 */

test('a multi-file task carries earlier results into later decisions', async () => {
  const run = await runScenario({
    prompt: '把 config.json 里的服务名写进 report.md',
    files: { 'config.json': '{"service":"conchbase","port":4318}' },
    allowWrites: true,
    turns: [
      // Step 1: discover the working set.
      { kind: 'tools', calls: [{ name: 'workspace_list', args: { path: '' } }] },
      // Step 2: read the discovered file.
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: 'config.json' } }] },
      // Step 3: write a derived artefact.
      { kind: 'tools', calls: [{ name: 'workspace_write', args: { path: 'report.md', content: '服务：conchbase' } }] },
      { kind: 'final', text: '已生成 report.md。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    assert.equal(run.read('report.md'), '服务：conchbase');
    // Every tool result must be present in the context of the next decision.
    const writesContext = JSON.stringify(run.requests.at(-1));
    assert.match(writesContext, /config\.json/, 'the file name from the listing survives');
    assert.match(writesContext, /conchbase/, 'the value read from config survives to the final call');
  } finally {
    run.cleanup();
  }
});

test('the agent can correct itself after a failed read', async () => {
  // First attempt misses; the failure is visible, and recovery must be possible
  // without restarting the task.
  const run = await runScenario({
    prompt: '读取配置',
    files: { 'config/app.json': '{"ok":true}' },
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: 'config.yml' } }] },
      { kind: 'tools', calls: [{ name: 'workspace_list', args: { path: 'config' } }] },
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: 'config/app.json' } }] },
      { kind: 'final', text: '配置为 ok=true。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    const failed = run.events.filter((event) => event.type === 'agent_loop.tool_failed');
    const ok = run.events.filter((event) => event.type === 'agent_loop.tool_executed');
    assert.equal(failed.length, 1, 'the bad path failed once');
    assert.ok(ok.length >= 2, 'the recovery reads succeeded');
    // Assert on the tool message itself. Matching the whole request body is
    // fragile: once the context grows, the relevant result can sit anywhere in
    // a large payload and a substring check tells you nothing about which tool.
    const toolMessages = (run.requests.at(-1) as {
      messages?: readonly { role?: string; content?: unknown }[];
    }).messages?.filter((message) => message.role === 'tool') ?? [];
    assert.ok(toolMessages.length >= 2, 'each successful read produces one tool result');
    assert.ok(
      toolMessages.some((message) => String(message.content).includes('"ok":true')),
      'the recovered file content reached the model as a tool result',
    );
  } finally {
    run.cleanup();
  }
});

test('a large file is paged instead of flooding the context', async () => {
  const big = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join('\n');
  const run = await runScenario({
    prompt: '读取大文件',
    files: { 'big.txt': big },
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_read', args: { path: 'big.txt' } }] },
      { kind: 'final', text: '读取片段完成。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    const last = JSON.stringify(run.requests.at(-1));
    // The tool result must be truncated with a continuation hint, not the whole
    // file: context flooding is a real failure mode for long-running agents.
    assert.ok(last.length < 60_000, `payload too large: ${last.length}`);
    assert.match(last, /offset/i, 'a truncated read tells the model how to continue');
  } finally {
    run.cleanup();
  }
});

test('two sequential writes both land on disk', async () => {
  const run = await runScenario({
    prompt: '创建两个文件',
    allowWrites: true,
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_write', args: { path: 'a.txt', content: 'A' } }] },
      { kind: 'tools', calls: [{ name: 'workspace_write', args: { path: 'b.txt', content: 'B' } }] },
      { kind: 'final', text: '两个文件都创建了。' },
    ],
  });
  try {
    assert.equal(run.state, 'succeeded', run.error ?? '');
    assert.equal(run.read('a.txt'), 'A');
    assert.equal(run.read('b.txt'), 'B');
    run.assertFiles(['a.txt', 'b.txt']);
  } finally {
    run.cleanup();
  }
});

test('a write that fails leaves no partial file behind', async () => {
  // Writing outside the root must fail closed: no file, no silent success.
  const run = await runScenario({
    prompt: '写到工作区外',
    allowWrites: true,
    turns: [
      { kind: 'tools', calls: [{ name: 'workspace_write', args: { path: '../escape.txt', content: 'x' } }] },
      { kind: 'final', text: '无法写入。' },
    ],
  });
  try {
    assert.equal(run.read('../escape.txt'), null);
    run.assertFiles([]);
    assert.ok(run.events.some((event) => event.type === 'agent_loop.tool_failed'));
  } finally {
    run.cleanup();
  }
});

test('an oversized tool batch fails before any tool runs', async () => {
  const run = await runScenario({
    prompt: '一次请求过多工具',
    files: { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' },
    maxToolCallsPerTurn: 2,
    turns: [
      {
        kind: 'tools',
        calls: ['a.txt', 'b.txt', 'c.txt'].map((file) => ({
          name: 'workspace_read', args: { path: file },
        })),
      },
      { kind: 'final', text: 'done' },
    ],
  });
  try {
    assert.equal(run.state, 'failed');
    assert.match(run.error ?? '', /at most 2 tool calls/i);
    assert.equal(run.events.some((event) => event.type === 'agent_loop.tool_requested'), false,
      'no tool may be partially executed when the batch is over the cap');
    assert.equal(run.requests.length, 1, 'the oversized turn is rejected before another model call');
  } finally {
    run.cleanup();
  }
});
