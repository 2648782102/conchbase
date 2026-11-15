import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenAiCompatibleProjectSummaryGenerator,
  deterministicProjectSummary,
  parseProjectSummary,
  projectSummaryFacts,
  renderProjectSummary,
  type ProjectSummaryFacts,
} from '../src/runtime/project-summary.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';

function facts(): ProjectSummaryFacts {
  return Object.freeze({
    projectId: 'project_alpha',
    purpose: '做一个统计工具',
    workers: Object.freeze([{ id: 'wrk_alpha', displayName: '统计员工', state: 'reporting' }]),
    reports: Object.freeze([
      { workerId: 'wrk_alpha', state: 'ready', body: '完成了 txtstat.js，输出正确。' },
    ]),
  });
}

test('a well-formed model summary is accepted', () => {
  const parsed = parseProjectSummary('project_alpha', {
    headline: '统计工具已完成并通过验证。',
    outcomes: ['实现 txtstat.js', '验证输出一致'],
    openIssues: [],
    nextSteps: ['可按需发布到 npm'],
  });
  assert.ok(parsed);
  assert.equal(parsed!.source, 'model');
  assert.deepEqual(parsed!.outcomes, ['实现 txtstat.js', '验证输出一致']);
});

test('a summary with unknown fields or a secret-like value is rejected', () => {
  // The shape is Runtime-owned: a model cannot smuggle extra fields through,
  // and a value that looks like a credential must never reach a published text.
  assert.equal(parseProjectSummary('p', {
    headline: 'ok', outcomes: [], openIssues: [], nextSteps: [], extra: true,
  }), null);
  assert.equal(parseProjectSummary('p', {
    headline: '使用 sk-abcdef 调用接口', outcomes: [], openIssues: [], nextSteps: [],
  }), null);
  assert.equal(parseProjectSummary('p', {
    headline: '', outcomes: [], openIssues: [], nextSteps: [],
  }), null);
});

test('the deterministic summary states real counts and never invents outcomes', () => {
  const document = deterministicProjectSummary(facts());
  assert.equal(document.source, 'runtime');
  assert.match(document.headline, /1 名员工/);
  assert.match(document.headline, /成功 1/);
  assert.match(document.outcomes[0]!, /完成了 txtstat\.js/);
  const text = renderProjectSummary(document);
  assert.match(text, /project_alpha/);
  assert.match(text, /成果：/);
});

test('a failing or malformed model output falls back to the runtime summary', async () => {
  const bodies: string[] = [];
  const generator = createOpenAiCompatibleProjectSummaryGenerator({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-model',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: readonly { content: string }[] };
      bodies.push(body.messages?.at(-1)?.content ?? '');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"headline":"ok","outcomes":[],"openIssues":[],"nextSteps":[]}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch,
  });
  const parsed = await generator(facts());
  assert.ok(parsed);
  assert.equal(parsed!.source, 'model');

  // Any upstream failure must produce null so the caller can fall back.
  const failing = createOpenAiCompatibleProjectSummaryGenerator({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-model',
    fetch: (async () => new Response('nope', { status: 500 })) as typeof globalThis.fetch,
  });
  assert.equal(await failing(facts()), null);

  const malformed = createOpenAiCompatibleProjectSummaryGenerator({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-model',
    fetch: (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not json' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch,
  });
  assert.equal(await malformed(facts()), null);
});

test('project summary facts collect only bounded project-local data', () => {
  const store = new InMemoryOrganizationStore();
  store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_beta', originTriggerId: 'int_beta' });
  store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_beta' });
  store.recordReportText?.('rpt_beta', 'beta 汇报');
  const snapshot = store.get();
  const collected = projectSummaryFacts(snapshot, 'project_beta', {
    purpose: '目标',
    reportTexts: store.reportTexts?.(),
  });
  assert.equal(collected.projectId, 'project_beta');
  assert.equal(collected.purpose, '目标');
  assert.equal(collected.workers.length, 0);
  assert.equal(collected.reports.length, 0);
});
