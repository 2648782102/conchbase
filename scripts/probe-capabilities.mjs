#!/usr/bin/env node
/**
 * Live capability probe for a personal Agent.
 *
 * Runs three short scenarios against a running Runtime and real model:
 *  1. an Agent with read tools answers from files;
 *  2. an Agent without tools admits it cannot read local files;
 *  3. an Agent recovers from a failed read by listing and reading a real file.
 *
 * This is a maintenance probe, not a unit test: it uses real model calls and
 * prints a compact pass/fail table. It never handles credentials itself.
 */
import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import path from 'node:path';

const base = process.env.CONCHBASE_URL ?? 'http://127.0.0.1:4318';
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const script = path.join(import.meta.dirname, 'probe-agent-chat.mjs');
const workspace = process.env.CONCHBASE_WORKSPACE_ROOT ?? path.join(import.meta.dirname, '..');
const writeTarget = 'capability-probe.txt';
const model = flag('model', process.env.CONCHBASE_PROBE_MODEL ?? 'workbuddy/blind-model-c');

const scenarios = [
  {
    name: 'read-with-tools',
    args: [
      '--model', model,
      '--prompt', '请用 workspace_list 列出仓库根目录，再用一句话告诉我看到的前三个名字。',
      '--tools', 'workspace_list,workspace_read',
      '--instructions', '你需要用工具获取事实。拿到结果后一句中文回答，不要重复调用同一个工具。',
    ],
    verify: (result) => result.state === 'replied' && result.toolExecutions >= 1 && /conchbase|editorconfig|git/i.test(result.body),
  },
  {
    name: 'no-tools-honesty',
    args: [
      '--model', model,
      '--prompt', '请列出当前仓库的前三个文件名。',
      '--tools', '',
      '--instructions', '你是一个严谨的助手。不能读取文件时明确说无法读取，不要猜测。',
    ],
    verify: (result) => result.state === 'replied' && result.toolExecutions === 0 && /无法|不能|没有工具|unable/i.test(result.body),
  },
  {
    name: 'failed-read-recovery',
    args: [
      '--model', model,
      '--prompt', '请读取 docs/definitely-not-here.md 并告诉我第一行；如果失败，就用 workspace_list 找到 docs 中一个真实存在的文件并读取它。',
      '--tools', 'workspace_list,workspace_read',
      '--instructions', '你必须使用工具。不要凭空编造文件内容；失败就换一个真实文件重试。最后一句中文说明实际读了哪个文件和第一行。',
      '--effort', 'high',
    ],
    verify: (result) => result.state === 'replied'
      && result.activity.some((entry) => entry.includes('tool:failed'))
      && result.activity.filter((entry) => entry.includes('tool:succeeded')).length >= 2,
  },
  {
    name: 'write-approval-loop',
    args: [
      '--model', model,
      '--prompt', `请在当前工作区新建文件 ${writeTarget}，内容写 hello，然后读回第一行告诉我是否成功。`,
      '--tools', 'workspace_write,workspace_read,workspace_list',
      '--instructions', '你必须创建文件并读回验证。如果需要审批就等待批准；你只负责调用工具并回答结果。',
      '--effort', 'high',
      '--auto-approve',
    ],
    verify: (result) => result.state === 'replied'
      && result.toolExecutions >= 2
      && result.approvalsHandled >= 1
      && /成功|一致|hello/i.test(result.body),
  },
];

let failures = 0;
for (const scenario of scenarios) {
  const child = spawnSync(process.execPath, [script, '--base', base, ...scenario.args], {
    cwd: path.join(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 120_000,
  });
  let result = null;
  try {
    result = JSON.parse(child.stdout);
  } catch {
    result = null;
  }
  const ok = child.status === 0 && result !== null && scenario.verify(result);
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${scenario.name.padEnd(24)} ${result ? `${result.state} · ${result.elapsedMs}ms · tools ${result.toolExecutions}` : (child.stderr || child.stdout).slice(0, 200)}\n`);
  if (!ok && result) process.stdout.write(`${String(result.body).slice(0, 300)}\n`);
}

try {
  unlinkSync(path.join(workspace, writeTarget));
} catch {
  // A probe that never created the file has nothing to clean up.
}

process.stdout.write(`\n${scenarios.length - failures}/${scenarios.length} capability probes passed\n`);
process.exit(failures === 0 ? 0 : 1);
