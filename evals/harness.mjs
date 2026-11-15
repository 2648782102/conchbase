#!/usr/bin/env node
/**
 * Live agent evaluation harness.
 *
 * Unlike the scenario tests, this drives a **real model** through the real
 * HTTP Runtime. What it can prove is different: the scripted suite proves the
 * Runtime carries state correctly, while this proves the whole loop — prompt,
 * tool grants, real tool calls, real model judgement — produces a correct
 * artefact on a task the agent has not seen.
 *
 * Discipline that makes the result meaningful:
 *  - a fresh Runtime on an ephemeral port with its own database and workspace
 *    per run, so nothing leaks between tasks or into the developer's checkout;
 *  - generous but bounded budgets, because long tasks legitimately iterate;
 *  - assertions on the workspace and the trace, never on the model's phrasing;
 *  - a machine-readable report under evals/reports, so regressions are diffable.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const model = flag('model', process.env.CONCHBASE_EVAL_MODEL ?? 'workbuddy/blind-model-h');
const only = flag('task', '');
const maxIterations = Number(flag('max-iterations', '40'));
const deadlineMs = Number(flag('deadline-ms', '900000'));
const taskTimeoutMs = Number(flag('task-timeout-ms', '900000'));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createConnection({ host: '127.0.0.1', port: 0 });
    probe.once('error', reject);
  }).catch(() => 4400 + Math.floor(Math.random() * 400));
}

async function waitFor(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function walk(root, relative = '') {
  const current = path.join(root, relative);
  if (!existsSync(current)) return [];
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, next));
    else files.push(next);
  }
  return files.sort();
}

function snapshotWorkspace(root) {
  const files = {};
  for (const relative of walk(root)) {
    const full = path.join(root, relative);
    if (statSync(full).size > 200_000) {
      files[relative] = `[large file ${statSync(full).size} bytes]`;
      continue;
    }
    files[relative] = readFileSync(full, 'utf8');
  }
  return files;
}

async function startRuntime(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve'], {
    cwd: repoRoot,
    env: { ...process.env, ...env, CONCHBASE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const ready = await waitFor(`${base}/v1/health`, 60_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`runtime did not start:\n${logs.join('').slice(-2000)}`);
  }
  return { child, base, logs };
}

async function call(base, method, urlPath, body) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${urlPath} -> ${response.status} ${text.slice(0, 400)}`);
  return payload;
}

const TERMINAL = new Set(['replied', 'failed', 'unavailable', 'succeeded', 'cancelled']);

/**
 * Runs one task against a fresh Agent and a fresh conversation, then returns
 * the trace and the resulting workspace for assertion.
 */
async function runTask({ base, workspace, task }) {
  const agent = await call(base, 'POST', '/v1/agents', {
    name: `评测员工-${task.id}`.slice(0, 60),
    instructions: task.instructions,
    providerId: 'magpie',
    modelId: model,
    grantedCapabilities: (task.tools ?? ['workspace_list', 'workspace_read']).map((name) => ({ kind: 'tool', name })),
  });
  const agentId = agent.agent.id;
  const conversation = await call(base, 'POST', '/v1/agent-chat/conversations', {
    agentId,
    reasoningEffort: 'medium',
  });
  const conversationId = conversation.id ?? conversation.conversation?.id;
  const started = Date.now();
  await call(base, 'POST', `/v1/agent-chat/conversations/${conversationId}/messages`, {
    text: task.prompt,
    idempotencyKey: `eval-${task.id}-${Date.now()}`,
  });
  let final = null;
  while (Date.now() - started < taskTimeoutMs) {
    const view = await call(base, 'GET', `/v1/agent-chat/conversations/${conversationId}`);
    const assistant = (view.messages ?? []).filter((message) => message.author === 'assistant');
    const last = assistant.at(-1);
    if (last && TERMINAL.has(last.state)) {
      final = last;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const elapsedMs = Date.now() - started;
  const activity = final?.activity ?? [];
  await call(base, 'POST', `/v1/agents/${agentId}/archive`, {}).catch(() => undefined);
  return {
    state: final?.state ?? 'timeout',
    elapsedMs,
    error: (final?.error ?? '').slice(0, 300) || null,
    body: (final?.body ?? '').slice(0, 1200),
    turns: activity.filter((entry) => entry.kind === 'turn').length,
    toolCalls: activity.filter((entry) => entry.kind === 'tool').length,
    approvals: activity.filter((entry) => entry.kind === 'approval').length,
    activity: activity.map((entry) => `${entry.kind}:${entry.state}:${entry.label ?? ''}`),
    workspace: snapshotWorkspace(workspace),
  };
}

async function main() {
  const tasksDir = path.join(import.meta.dirname, 'tasks');
  const all = readdirSync(tasksDir).filter((name) => name.endsWith('.mjs')).sort();
  const selected = only ? all.filter((name) => name.includes(only)) : all;
  if (selected.length === 0) {
    console.error(`no eval tasks matched${only ? ` '${only}'` : ''}`);
    process.exit(2);
  }

  const runDirectory = mkdtempSync(path.join(tmpdir(), 'conchbase-eval-'));
  const workspace = path.join(runDirectory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const database = path.join(runDirectory, 'runtime.sqlite');

  const runtime = await startRuntime({
    CONCHBASE_DB: database,
    CONCHBASE_WORKSPACE_ROOT: workspace,
    CONCHBASE_ALLOW_TOOL_WRITES: '1',
    CONCHBASE_EXECUTION_MODE: 'unrestricted',
    CONCHBASE_MAX_ITERATIONS: String(maxIterations),
    CONCHBASE_LOOP_DEADLINE_MS: String(deadlineMs),
    CONCHBASE_MODEL: model,
    CONCHBASE_BOSS_MODEL: model,
  });

  const results = [];
  try {
    for (const file of selected) {
      const module = await import(path.join(tasksDir, file));
      const task = module.default;
      if (!task?.id || typeof task.setup !== 'function' || typeof task.prompt !== 'string') {
        throw new Error(`${file} must export { id, prompt, setup(workspace), assert({ run, read }) }`);
      }
      for (const relative of Object.keys(task.setup())) {
        const target = path.join(workspace, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, task.setup()[relative]);
      }
      const before = snapshotWorkspace(workspace);
      const run = await runTask({ base: runtime.base, workspace, task });
      const read = (relative) => {
        const target = path.join(workspace, relative);
        return existsSync(target) ? readFileSync(target, 'utf8') : null;
      };
      let verdict;
      try {
        const assertion = await task.assert({ run, read, before });
        verdict = assertion === undefined ? { passed: true } : assertion;
      } catch (cause) {
        verdict = { passed: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
      results.push({ task: task.id, model, ...verdict, run });
      const status = verdict.passed ? 'PASS' : 'FAIL';
      process.stdout.write(`${status}  ${task.id}  ${Math.round(run.elapsedMs / 1000)}s  turns=${run.turns} tools=${run.toolCalls}\n`);
      if (!verdict.passed) process.stdout.write(`      ${verdict.reason}\n`);
    }
  } finally {
    runtime.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!runtime.child.killed) runtime.child.kill('SIGKILL');
  }

  const reportDirectory = path.join(import.meta.dirname, 'reports');
  mkdirSync(reportDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDirectory, `${stamp}.json`);
  const passed = results.filter((result) => result.passed).length;
  const report = {
    version: 1,
    startedAt: stamp,
    model,
    budget: { maxIterations, deadlineMs, taskTimeoutMs },
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!hasFlag('keep')) rmSync(runDirectory, { recursive: true, force: true });
  else process.stdout.write(`workspace kept at ${runDirectory}\n`);

  process.stdout.write(`\n${passed}/${results.length} passed  report: ${path.relative(repoRoot, reportPath)}\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.stack : String(cause));
  process.exit(1);
});
