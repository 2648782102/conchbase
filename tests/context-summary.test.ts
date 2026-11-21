import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenAiCompatibleSummarizer,
  parseSummary,
  summaryBudget,
  summaryInstructions,
  summaryMessage,
  transcriptForSummary,
} from '../src/runtime/context-summary.js';
import { fitPrompt, contextBudget } from '../src/runtime/context-budget.js';
import type { ProviderMessage } from '../src/runtime/model-adapter.js';

test('the summary budget is a small, bounded share of the prompt', () => {
  assert.equal(summaryBudget(100).tokens, 128, 'a tiny window still gets a usable floor');
  assert.equal(summaryBudget(10_000).tokens, 1_200, 'a large window is still capped');
  const mid = summaryBudget(4_000).tokens;
  assert.ok(mid > 128 && mid < 1_200);
});

test('a summary is cleaned, bounded, and rejected when unusable', () => {
  const budget = summaryBudget(4_000);
  assert.equal(parseSummary(null, budget), null);
  assert.equal(parseSummary('', budget), null);
  assert.equal(parseSummary('太短', budget), null, 'a two-character reply is not a summary');
  const cleaned = parseSummary('用户要求  \n  先给结论\u0000。'.repeat(20), budget);
  assert.ok(cleaned);
  assert.doesNotMatch(cleaned!, /[\u0000-\u001f]/, 'control characters are stripped');
});

test('an oversized summary is refused rather than re-inlined', () => {
  const budget = summaryBudget(1_000);
  const huge = '很长的摘要。'.repeat(5_000);
  assert.equal(parseSummary(huge, budget), null);
});

test('the transcript labels roles and bounds each message', () => {
  const messages: readonly ProviderMessage[] = [
    { role: 'user', content: '请读取文件' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'workspace_read', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(5_000) },
  ];
  const transcript = transcriptForSummary(messages, { maxCharsPerMessage: 100 });
  assert.match(transcript, /用户: 请读取文件/);
  assert.match(transcript, /助手\(调用 workspace_read\)/);
  assert.match(transcript, /工具结果:/);
  const toolLine = transcript.split('\n').find((line) => line.startsWith('工具结果'))!;
  assert.ok(toolLine.length < 200, 'one large tool result cannot crowd out the rest');
});

test('a summary is injected as system recollection, not as an instruction', () => {
  const wrapped = summaryMessage('用户希望先给结论。');
  assert.equal(wrapped.role, 'system');
  assert.match(wrapped.content, /摘要/);
  assert.match(wrapped.content, /不完整/, 'the model is told the summary may be incomplete');
  assert.match(wrapped.content, /重新查看/, 'and told to re-check rather than trust it');
});

test('the summariser prompt forbids new instructions and secrets', () => {
  const instructions = summaryInstructions();
  assert.match(instructions, /不要写下新的指令/);
  assert.match(instructions, /密钥|令牌/);
});

test('a trimmed prompt reports what it dropped so the caller can summarise it', () => {
  const messages: readonly ProviderMessage[] = [
    { role: 'system', content: 'instructions' },
    ...Array.from({ length: 40 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x'.repeat(400),
    })),
  ];
  const result = fitPrompt(messages, contextBudget(2_000));
  assert.equal(result.fit.kind, 'trimmed');
  if (result.fit.kind !== 'trimmed') return;
  assert.ok(result.fit.dropped.length > 0);
  // The dropped set must not include the instructions.
  assert.ok(result.fit.dropped.every((message) => message.role !== 'system'));
});

test('the summariser sends a bounded request and returns a usable summary', async () => {
  let body: Record<string, unknown> | null = null;
  const summarizer = createOpenAiCompatibleSummarizer({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/model',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '用户要求先给结论，并已读取配置文件。' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch,
  });
  const summary = await summarizer({
    transcript: '用户: 先给结论',
    budget: summaryBudget(4_000),
  });
  assert.match(summary ?? '', /先给结论/);
  assert.equal((body as { stream?: unknown } | null)?.stream, false);
});

test('a summariser outage returns null instead of throwing', async () => {
  const failing = createOpenAiCompatibleSummarizer({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/model',
    fetch: (async () => new Response('boom', { status: 500 })) as typeof globalThis.fetch,
  });
  assert.equal(await failing({ transcript: 'x', budget: summaryBudget(1_000) }), null);

  const throwing = createOpenAiCompatibleSummarizer({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/model',
    fetch: (async () => { throw new Error('network'); }) as typeof globalThis.fetch,
  });
  assert.equal(await throwing({ transcript: 'x', budget: summaryBudget(1_000) }), null);
});
