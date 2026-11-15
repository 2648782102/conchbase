import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryAgentMemoryStore } from '../src/runtime/agent-memory.js';
import {
  OrganizationIntentParseError,
  parseBossConversationResult,
  type OrganizationIntentParser,
  type OrganizationIntentParserInput,
} from '../src/runtime/organization-intent-parser.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';

function baseInput(store: InMemoryOrganizationStore): OrganizationIntentParserInput {
  return Object.freeze({
    intentId: 'int_memory_write',
    text: '记住：以后回答先给结论',
    expectedSequence: store.get().events.length,
    snapshot: store.get(),
  });
}

test('a project memory proposal is accepted only for an existing project', () => {
  const store = new InMemoryOrganizationStore();
  store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_alpha', originTriggerId: 'int_alpha' });
  const parsed = parseBossConversationResult(baseInput(store), {
    reply: '记住了。',
    actions: [],
    memory: [{
      scope: 'project',
      scopeId: 'project_alpha',
      key: 'style',
      title: '先给结论',
      body: '回答时先给一句话结论。',
    }],
  });
  assert.equal(parsed.memory?.length, 1);
  assert.equal(parsed.memory?.[0]?.scopeId, 'project_alpha');
});

test('runtime scope is accepted as a proposal but never self-authorizing', () => {
  const store = new InMemoryOrganizationStore();
  const base = baseInput(store);
  // Parsing accepts the proposal; authority is decided later by the Runtime and
  // requires an independent reviewer confirmation. See the write tests below.
  const parsed = parseBossConversationResult(base, {
    reply: 'ok', actions: [],
    memory: [{ scope: 'runtime', key: 'k', title: 't', body: 'b' }],
  });
  assert.equal(parsed.memory?.[0]?.scope, 'runtime');
  assert.throws(() => parseBossConversationResult(base, {
    reply: 'ok', actions: [],
    memory: [{ scope: 'project', scopeId: 'p', key: 'k', title: 't', body: 'token sk-abcdef' }],
  }), OrganizationIntentParseError);
  assert.throws(() => parseBossConversationResult(base, {
    reply: 'ok', actions: [], memory: [{}],
  }), OrganizationIntentParseError);
  assert.throws(() => parseBossConversationResult(base, {
    reply: 'ok', actions: [], memory: 'remember everything',
  }), OrganizationIntentParseError);
});

test('a proposal with no memory field parses exactly as before', () => {
  const store = new InMemoryOrganizationStore();
  const parsed = parseBossConversationResult(baseInput(store), { reply: '你好', actions: [] });
  assert.equal(parsed.memory, undefined);
});

async function submitWith(
  parser: OrganizationIntentParser,
  memory: InMemoryAgentMemoryStore,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-memory-write-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
  });
  const store = new InMemoryOrganizationStore();
  store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_alpha', originTriggerId: 'int_alpha' });
  const boss = new BossModeService(store, taskService, { parser, memory, waitForTasks: false });
  try {
    await boss.submit({ text: '记住这件事', idempotencyKey: 'memory-write-1' });
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the Runtime persists a valid proposal and drops a dangling one', async () => {
  const memory = new InMemoryAgentMemoryStore();
  const parser: OrganizationIntentParser = {
    async parse() {
      return Object.freeze({
        version: 1 as const,
        intentId: 'int_memory_write',
        actions: Object.freeze([]),
        relay: '记住了。',
        memory: Object.freeze([
          Object.freeze({ scope: 'project' as const, scopeId: 'project_alpha', key: 'k1', title: '有效记忆', body: '正文' }),
          Object.freeze({ scope: 'project' as const, scopeId: 'project_missing', key: 'k2', title: '悬空记忆', body: '正文' }),
        ]),
      });
    },
  };
  await submitWith(parser, memory);
  const entries = memory.list({ scope: 'project', scopeId: 'project_alpha' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.title, '有效记忆');
  // A memory about a project that does not exist must not become a durable fact.
  assert.equal(memory.list({ scope: 'project', scopeId: 'project_missing' }).length, 0);
});
