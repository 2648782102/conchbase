import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import {
  WorkConflictError,
  WorkValidationError,
  parseWorkTriggerRequest,
  planDurableWork,
  workProposalDigest,
} from '../src/runtime/work-contract.js';

const digestA = `sha256:${createHash('sha256').update('payload-a').digest('hex')}`;
const digestB = `sha256:${createHash('sha256').update('payload-b').digest('hex')}`;
const capabilities = `sha256:${createHash('sha256').update('capabilities').digest('hex')}`;

function triggerRequest(overrides: Record<string, unknown> = {}) {
  return {
    source: { sourceId: 'fake.inbox', kind: 'fake' },
    trigger: {
      triggerId: 'event-001',
      threadKey: 'thread-a',
      payloadDigest: digestA,
      occurredAt: '2026-11-11T00:00:00.000Z',
    },
    mandate: {
      scope: ['read-local-fixture'],
      allowedOperations: ['observe'],
      capabilitiesDigest: capabilities,
    },
    model: { providerId: 'fake', modelId: 'fixture' },
    agentRevisionId: 'rev_fixture',
    configurationRevisionId: 'cfg_fixture',
    ...overrides,
  };
}

function withStore(action: (store: SqliteTaskStore, filename: string, markClosed: () => void) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-work-contract-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const store = new SqliteTaskStore(filename);
  let closed = false;
  try {
    action(store, filename, () => { closed = true; });
  } finally {
    if (!closed) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('pure work validation rejects secret-like fields, paths, topology vocabulary, and bad digests', () => {
  assert.throws(
    () => parseWorkTriggerRequest(triggerRequest({ source: { sourceId: 'https://example.com', kind: 'fake' } })),
    WorkValidationError,
  );
  assert.throws(
    () => parseWorkTriggerRequest(triggerRequest({ trigger: {
      triggerId: 'event-001', threadKey: 'thread-a', payloadDigest: 'not-a-digest',
      occurredAt: '2026-11-11T00:00:00.000Z',
    } })),
    WorkValidationError,
  );
  assert.throws(
    () => parseWorkTriggerRequest(triggerRequest({ mandate: {
      scope: ['router'], allowedOperations: ['observe'], capabilitiesDigest: capabilities,
    } })),
    WorkValidationError,
  );
  assert.throws(
    () => parseWorkTriggerRequest({ ...triggerRequest(), token: 'fake-secret' }),
    WorkValidationError,
  );
  assert.throws(
    () => parseWorkTriggerRequest({ ...triggerRequest(), apiKey: 'fake-secret' }),
    WorkValidationError,
  );
});

test('durable work keeps WorkItem, Assignment, Outbox, and DeliveryReceipt identities distinct', () => {
  const parsed = parseWorkTriggerRequest(triggerRequest());
  const plan = planDurableWork(parsed);
  assert.equal(plan.workItem.state, 'open');
  assert.equal(plan.assignments[0]?.state, 'planned');
  assert.equal(plan.outbox[0]?.status, 'pending');
  assert.equal(plan.deliveryReceipts[0]?.status, 'observed');
  assert.notEqual(plan.workItem.id, plan.assignments[0]?.id);
  assert.equal(plan.deliveryReceipts[0]?.outboxId, plan.outbox[0]?.id);
  assert.equal(workProposalDigest(parsed), plan.trigger.proposalDigest);
  assert.doesNotMatch(JSON.stringify(plan), /Router|Worker|three-layer|layered|hierarchy/i);
});

test('SQLite work store is idempotent, preserves context-only subscriptions, and survives restart', () => {
  withStore((store, filename, markClosed) => {
    const first = parseWorkTriggerRequest(triggerRequest());
    const envelope = store.work.ingestWorkTrigger(first);
    assert.equal(envelope.created, true);
    assert.equal(envelope.workItemCreated, true);
    assert.equal(envelope.contextOnly, false);
    assert.equal(envelope.events.length, 5);
    assert.equal(envelope.thread.triggerIds.length, 1);
    assert.equal(envelope.deliveryReceipts[0]?.status, 'observed');

    const duplicate = store.work.ingestWorkTrigger(first);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.workItemCreated, false);
    assert.equal(duplicate.events.length, 5);
    assert.equal(store.work.listWorkItems().length, 1);

    const context = parseWorkTriggerRequest(triggerRequest({
      trigger: {
        triggerId: 'event-002',
        threadKey: 'thread-a',
        payloadDigest: digestB,
        occurredAt: '2026-11-11T00:00:01.000Z',
      },
    }));
    const contextEnvelope = store.work.ingestWorkTrigger(context);
    assert.equal(contextEnvelope.created, true);
    assert.equal(contextEnvelope.workItemCreated, false);
    assert.equal(contextEnvelope.contextOnly, true);
    assert.equal(contextEnvelope.thread.triggerIds.length, 2);
    assert.equal(contextEnvelope.mandate.id, envelope.mandate.id);
    assert.equal(contextEnvelope.assignments[0]?.id, envelope.assignments[0]?.id);
    assert.equal(contextEnvelope.deliveryReceipts.length, 1);
    assert.equal(contextEnvelope.events.length, 6);
    assert.equal(store.work.listWorkItems().length, 1);

    const widened = parseWorkTriggerRequest(triggerRequest({
      trigger: {
        triggerId: 'event-003',
        threadKey: 'thread-a',
        payloadDigest: digestB,
        occurredAt: '2026-11-11T00:00:02.000Z',
      },
      mandate: {
        scope: ['read-local-fixture', 'write-external'],
        allowedOperations: ['observe'],
        capabilitiesDigest: capabilities,
      },
    }));
    assert.throws(() => store.work.ingestWorkTrigger(widened), WorkConflictError);
    assert.equal(store.work.listWorkItems().length, 1);

    const conflicting = parseWorkTriggerRequest(triggerRequest({
      trigger: {
        triggerId: 'event-001',
        threadKey: 'thread-b',
        payloadDigest: digestB,
        occurredAt: '2026-11-11T00:00:03.000Z',
      },
    }));
    assert.throws(() => store.work.ingestWorkTrigger(conflicting), WorkConflictError);

    store.close();
    markClosed();
    const reopened = new SqliteTaskStore(filename);
    try {
      assert.equal(reopened.work.listWorkItems().length, 1);
      const detail = reopened.work.getWorkItemDetail(envelope.workItem.id);
      assert.equal(detail.thread.triggerIds.length, 2);
      assert.equal(detail.mandate.id, envelope.mandate.id);
      assert.equal(detail.assignments[0]?.state, 'planned');
      assert.equal(detail.outbox[0]?.status, 'pending');
      assert.equal(detail.deliveryReceipts[0]?.status, 'observed');
      assert.equal(reopened.work.listDeliveryReceipts().length, 1);
      assert.equal(reopened.work.ingestWorkTrigger(first).created, false);
    } finally {
      reopened.close();
    }
  });
});

test('four public work routes expose the deterministic contract without external execution', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-work-http-'));
  const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
  const app = createApp({ logger: false, taskService: { store } as never });
  try {
    const unconfigured = createApp({ logger: false });
    try {
      const unavailable = await unconfigured.inject({ method: 'GET', url: '/v1/work/items' });
      assert.equal(unavailable.statusCode, 503);
    } finally {
      await unconfigured.close();
    }

    const created = await app.inject({
      method: 'POST',
      url: '/v1/work/triggers',
      payload: triggerRequest(),
    });
    assert.equal(created.statusCode, 201);
    const envelope = created.json<{ workItem: { id: string }; created: boolean }>();
    assert.equal(envelope.created, true);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/work/triggers',
      payload: triggerRequest(),
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json<{ created: boolean }>().created, false);

    const list = await app.inject({ method: 'GET', url: '/v1/work/items' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json<{ workItems: unknown[] }>().workItems.length, 1);

    const detail = await app.inject({ method: 'GET', url: `/v1/work/items/${envelope.workItem.id}` });
    assert.equal(detail.statusCode, 200);
    const missing = await app.inject({ method: 'GET', url: '/v1/work/items/work_unknown' });
    assert.equal(missing.statusCode, 404);

    const receipts = await app.inject({ method: 'GET', url: '/v1/work/delivery-receipts' });
    assert.equal(receipts.statusCode, 200);
    assert.equal(receipts.json<{ deliveryReceipts: unknown[] }>().deliveryReceipts.length, 1);

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/work/triggers',
      payload: { ...triggerRequest(), source: { sourceId: 'fake.token', kind: 'fake' } },
    });
    assert.equal(invalid.statusCode, 400);

    const unknownField = await app.inject({
      method: 'POST',
      url: '/v1/work/triggers',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...triggerRequest(), unsupportedField: 'ignored' }),
    });
    assert.equal(unknownField.statusCode, 400);

    const malformedJson = await app.inject({
      method: 'POST',
      url: '/v1/work/triggers',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    });
    assert.equal(malformedJson.statusCode, 400);
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
