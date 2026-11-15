import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { InMemoryAgentMemoryStore } from '../src/runtime/agent-memory.js';
import type { TaskStore } from '../src/runtime/task-store.js';

function appWith(memory: InMemoryAgentMemoryStore) {
  const taskService = { store: { memory } as unknown as TaskStore } as never;
  return createApp({ logger: false, taskService });
}

test('memory can be listed with a scope filter', async () => {
  const memory = new InMemoryAgentMemoryStore();
  memory.write({ scope: 'runtime', key: 'tone', title: '简洁回答', body: '短答。' });
  memory.write({ scope: 'project', scopeId: 'project_alpha', key: 'fmt', title: '先给结论', body: '结论优先。' });
  const app = appWith(memory);
  try {
    const all = await app.inject({ method: 'GET', url: '/v1/memory' });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().version, '1.9.0');
    assert.equal(all.json().entries.length, 2);

    const scoped = await app.inject({ method: 'GET', url: '/v1/memory?scope=project&scopeId=project_alpha' });
    assert.equal(scoped.json().entries.length, 1);
    assert.equal(scoped.json().entries[0].title, '先给结论');
  } finally {
    await app.close();
  }
});

test('every listed entry exposes provenance and review status', async () => {
  const memory = new InMemoryAgentMemoryStore();
  memory.write({
    scope: 'project', scopeId: 'p', key: 'k', title: 't', body: 'b',
    sourceIntentId: 'int_abc', reviewedBy: 'accepted',
  });
  const app = appWith(memory);
  try {
    const entry = (await app.inject({ method: 'GET', url: '/v1/memory' })).json().entries[0];
    assert.equal(entry.sourceIntentId, 'int_abc');
    assert.equal(entry.reviewedBy, 'accepted');
  } finally {
    await app.close();
  }
});

test('deletion removes the entry and reports a missing id', async () => {
  const memory = new InMemoryAgentMemoryStore();
  const entry = memory.write({ scope: 'runtime', key: 'k', title: 't', body: 'b' });
  const app = appWith(memory);
  try {
    const deleted = await app.inject({ method: 'DELETE', url: `/v1/memory/${entry.id}` });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().removed, true);
    assert.equal(memory.get(entry.id), null);

    const again = await app.inject({ method: 'DELETE', url: `/v1/memory/${entry.id}` });
    assert.equal(again.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('invalid filters are rejected and there is no public write path', async () => {
  const memory = new InMemoryAgentMemoryStore();
  const app = appWith(memory);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/memory?scope=global' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/memory?limit=0' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/memory?limit=201' })).statusCode, 400);
    // A client must not be able to inject a fact the Boss will later recall.
    const post = await app.inject({ method: 'POST', url: '/v1/memory', payload: {} });
    assert.ok(post.statusCode === 404 || post.statusCode === 405, `no write route, got ${post.statusCode}`);
  } finally {
    await app.close();
  }
});
