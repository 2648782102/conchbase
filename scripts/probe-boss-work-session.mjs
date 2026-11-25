#!/usr/bin/env node
/**
 * Live Boss work-session probe.

 * Simulates the real interaction that exposed the current bugs: hand the Boss
 * a small delegated task, keep talking while a worker runs, then wait for the
 * Runtime notice and check the organization facts. It is a development probe,
 * not a unit test: it costs real model calls and needs a running Runtime.
 *
 * Usage:
 *   node scripts/probe-boss-work-session.mjs
 *   node scripts/probe-boss-work-session.mjs --base http://127.0.0.1:4318 --wait-ms 90000
 */
const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const base = flag('base', 'http://127.0.0.1:4318').replace(/\/$/, '');
const waitMs = Number(flag('wait-ms', '90000'));
const task = flag('task', 'read');

const TASKS = Object.freeze({
  read: {
    text: '请立即开始并完成：招一名员工读取 docs/START_HERE.md，用一句话概括用途。',
    match: /docs\/START_HERE\.md/i,
  },
  continue: {
    text: '请立即开始并完成：让百度热搜检索员继续查第 6 个热门话题，输出标题、热度和来源。',
    match: /第六|第 6|百度|热搜/i,
  },
});
const scenario = TASKS[task] ?? TASKS.read;
let firstUserSeq = 0;

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return payload;
}

const conversation = await call('POST', '/v1/agent-chat/conversations', { agentId: 'boss-agent' });
const conversationId = conversation.id;
const started = Date.now();
const send = (text, key) => call('POST', `/v1/agent-chat/conversations/${conversationId}/messages`, {
  text,
  idempotencyKey: `${key}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
});

const delegated = await send(scenario.text, 'delegate');
firstUserSeq = delegated.userMessage?.sequence ?? 1;
await new Promise((resolve) => setTimeout(resolve, 300));
await send('员工干活期间继续聊：你的安排原则是什么？只回答这个问题。', 'continue');

const deadline = started + waitMs;
let view;
let notices = [];
let beforeSession = null;
while (Date.now() < deadline) {
  view = await call('GET', `/v1/agent-chat/conversations/${conversationId}`);
  const currentSession = await call('GET', '/v1/organization/session');
  if (beforeSession === null) beforeSession = currentSession;
  notices = (view.messages ?? []).filter((item) =>
    item.author === 'runtime'
    && /员工/.test(item.body ?? '')
    && scenario.match.test(item.body ?? '')
    && item.sequence > firstUserSeq);
  const reportCount = (beforeSession.reports ?? []).length;
  const newReport = (currentSession.reports ?? []).length > reportCount;
  const newWorker = (currentSession.workers ?? []).length > (beforeSession.workers ?? []).length;
  if (notices.length > 0 || newReport || newWorker) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const session = await call('GET', '/v1/organization/session');
const users = (view?.messages ?? []).filter((item) => item.author === 'user');
const assistant = (view?.messages ?? []).filter((item) => item.author === 'assistant');
const failures = [];
if (users.length < 2) failures.push('second user message was not accepted');
if (assistant.length < 2) failures.push('second boss reply did not land');
if (notices.length === 0) failures.push('no worker report notice arrived');
if ((session.workers ?? []).length === 0) failures.push('no worker in organization session');
if ((session.reports ?? []).length === 0) failures.push('no durable worker report');

console.log(JSON.stringify({
  conversationId,
  elapsedMs: Date.now() - started,
  userMessages: users.length,
  bossReplies: assistant.length,
  workerNotices: notices.map((item) => (item.body ?? '').slice(0, 240)),
  projects: (session.projects ?? []).length,
  workers: (session.workers ?? []).length,
  reports: (session.reports ?? []).map((item) => item.state),
  failures,
}, null, 2));
process.exit(failures.length > 0 ? 1 : 0);
