import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BossModeService } from '../src/runtime/boss-mode-service.js';
import { InMemoryAgentMemoryStore } from '../src/runtime/agent-memory.js';
import type { OrganizationIntentParser, OrganizationIntentParserInput } from '../src/runtime/organization-intent-parser.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { createTaskService } from '../src/runtime/task-service.js';

/** A parser that records what the Boss service hands it. */
function recordingParser(): { parser: OrganizationIntentParser; seen: OrganizationIntentParserInput[] } {
  const seen: OrganizationIntentParserInput[] = [];
  const parser: OrganizationIntentParser = {
    async parse(input) {
      seen.push(input);
      return Object.freeze({
        version: 1 as const,
        intentId: input.intentId,
        actions: Object.freeze([]),
        relay: '收到。',
      });
    },
  };
  return { parser, seen };
}

test('the Boss prompt receives a bounded memory index', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-memory-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
  });
  try {
    const store = new InMemoryOrganizationStore();
    // An active project plus its memory, and an archived project's memory that
    // must not be injected as if it were current.
    store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_live', originTriggerId: 'int_live' });
    store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_live' });
    const memory = new InMemoryAgentMemoryStore();
    memory.write({ scope: 'runtime', key: 'tone', title: '用户偏好简洁回答', body: '短答。' });
    memory.write({ scope: 'project', scopeId: 'project_live', key: 'summary', title: '在办项目的历史结论', body: '历史正文。' });
    memory.write({ scope: 'project', scopeId: 'project_old', key: 'summary', title: '已归档项目结论', body: '旧正文。' });

    const { parser, seen } = recordingParser();
    const boss = new BossModeService(store, taskService, { parser, memory, waitForTasks: false });
    await boss.submit({ text: '你还记得之前做过什么吗', idempotencyKey: 'memory-1' });

    assert.equal(seen.length, 1);
    const index = seen[0]!.memoryIndex ?? '';
    assert.match(index, /用户偏好简洁回答/, 'runtime memory applies everywhere');
    assert.match(index, /在办项目的历史结论/, 'an active project contributes its memory');
    assert.doesNotMatch(index, /已归档项目结论/, 'archived project memory must not be injected as current context');
    assert.doesNotMatch(index, /历史正文|旧正文/, 'bodies stay out of the prompt');
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a memory-store failure never breaks a Boss turn', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-memory-broken-'));
  const taskService = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture-model',
  });
  try {
    const store = new InMemoryOrganizationStore();
    const broken = {
      initialize() {},
      write() { throw new Error('disk full'); },
      list() { throw new Error('disk full'); },
      get() { return null; },
      remove() { return false; },
    };
    const { parser, seen } = recordingParser();
    const boss = new BossModeService(store, taskService, { parser, memory: broken, waitForTasks: false });
    const result = await boss.submit({ text: '你好', idempotencyKey: 'memory-2' });
    assert.equal(result.state, 'accepted');
    assert.equal(seen[0]!.memoryIndex, undefined);
  } finally {
    await taskService.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
