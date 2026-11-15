import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOpenAiCompatibleMemoryReviewer,
  parseMemoryReviewResult,
  type MemoryReviewInput,
} from '../src/runtime/memory-review.js';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryAgentMemoryStore } from '../src/runtime/agent-memory.js';
import type { OrganizationIntentParser } from '../src/runtime/organization-intent-parser.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';

function proposals(): MemoryReviewInput {
  return {
    userText: '请以后都先给结论',
    assistantReply: '记住了。',
    existingTitles: [],
    proposals: [
      { scope: 'project', scopeId: 'project_alpha', key: 'fmt', title: '先给结论', body: '回答先给结论。' },
    ],
  };
}

test('a well-formed verdict is accepted', () => {
  const parsed = parseMemoryReviewResult({
    decisions: [{ index: 0, verdict: 'accept', reason: '用户明确要求长期偏好' }],
  }, 1);
  assert.ok(parsed);
  assert.equal(parsed!.decisions[0]!.verdict, 'accept');
});

test('verdicts must cover every proposal exactly once', () => {
  // A partial verdict set is ambiguous; accepting the omitted ones silently
  // would turn "no decision" into consent.
  assert.equal(parseMemoryReviewResult({ decisions: [] }, 1), null);
  assert.equal(parseMemoryReviewResult({
    decisions: [{ index: 0, verdict: 'accept', reason: '' }, { index: 0, verdict: 'reject', reason: '' }],
  }, 2), null);
  assert.equal(parseMemoryReviewResult({
    decisions: [{ index: 5, verdict: 'accept', reason: '' }],
  }, 1), null);
});

test('malformed verdicts and secret-like reasons are rejected', () => {
  assert.equal(parseMemoryReviewResult({
    decisions: [{ index: 0, verdict: 'maybe', reason: '' }],
  }, 1), null);
  assert.equal(parseMemoryReviewResult({
    decisions: [{ index: 0, verdict: 'accept', reason: '', extra: true }],
  }, 1), null);
  assert.equal(parseMemoryReviewResult({
    decisions: [{ index: 0, verdict: 'accept', reason: 'token sk-abcdef' }],
  }, 1), null);
  assert.equal(parseMemoryReviewResult({ decisions: [], extra: 1 }, 0), null);
});

test('the reviewer returns null on upstream failure instead of throwing', async () => {
  const failing = createOpenAiCompatibleMemoryReviewer({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-model',
    fetch: (async () => new Response('nope', { status: 500 })) as typeof globalThis.fetch,
  });
  assert.equal(await failing(proposals()), null);
  const throwing = createOpenAiCompatibleMemoryReviewer({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture-model',
    fetch: (async () => { throw new Error('network down'); }) as typeof globalThis.fetch,
  });
  assert.equal(await throwing(proposals()), null);
});

async function submitWithBoss(options: {
  memory: InMemoryAgentMemoryStore;
  reviewer?: (input: MemoryReviewInput) => Promise<unknown>;
}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-review-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
  });
  const store = new InMemoryOrganizationStore();
  store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_alpha', originTriggerId: 'int_alpha' });
  const parser: OrganizationIntentParser = {
    async parse() {
      return Object.freeze({
        version: 1 as const,
        intentId: 'int_review',
        actions: Object.freeze([]),
        relay: '记住了。',
        memory: Object.freeze([
          Object.freeze({ scope: 'project' as const, scopeId: 'project_alpha', key: 'fmt', title: '先给结论', body: '回答先给结论。' }),
        ]),
      });
    },
  };
  const boss = new BossModeService(store, taskService, {
    parser,
    memory: options.memory,
    ...(options.reviewer ? { memoryReviewer: options.reviewer as never } : {}),
    waitForTasks: false,
  });
  try {
    await boss.submit({ text: '请以后都先给结论', idempotencyKey: 'review-1' });
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('an accepted proposal is written with provenance and review status', async () => {
  const memory = new InMemoryAgentMemoryStore();
  await submitWithBoss({
    memory,
    reviewer: async () => ({
      version: 1,
      decisions: [{ index: 0, verdict: 'accept', reason: 'durable preference' }],
    }),
  });
  const entries = memory.list({ scope: 'project', scopeId: 'project_alpha' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.reviewedBy, 'accepted');
  // Every entry must be traceable to the turn that produced it; a blank
  // provenance would make the fact unauditable and impossible to retract.
  assert.match(entries[0]!.sourceIntentId, /^int_/, 'provenance is recorded');
});

test('a rejected proposal is not persisted', async () => {
  const memory = new InMemoryAgentMemoryStore();
  await submitWithBoss({
    memory,
    reviewer: async () => ({
      version: 1,
      decisions: [{ index: 0, verdict: 'reject', reason: 'one-off instruction' }],
    }),
  });
  assert.equal(memory.list({ scope: 'project', scopeId: 'project_alpha' }).length, 0);
});

test('an unavailable reviewer drops the proposal rather than writing unreviewed', async () => {
  // If review is configured, silently falling back to an unreviewed write would
  // defeat the reason the reviewer exists.
  const memory = new InMemoryAgentMemoryStore();
  await submitWithBoss({ memory, reviewer: async () => null });
  assert.equal(memory.list({ scope: 'project', scopeId: 'project_alpha' }).length, 0);
});
