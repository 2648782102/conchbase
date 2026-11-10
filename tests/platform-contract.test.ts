import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PLATFORM_CONTRACT_VERSION,
  PlatformConflictError,
  PlatformValidationError,
  parseCapabilityWrite,
  parsePairingCreate,
  parseSecretHandleCreate,
  parseSourceEvent,
  parseWorkControl,
  rawSha256Digest,
} from '../src/runtime/platform-contract.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { parseWorkTriggerRequest } from '../src/runtime/work-contract.js';

const FIXED_SECRET = 'fixture-secret-never-logged';
const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const now = '2026-11-11T00:00:00.000Z';

function triggerRequest(overrides: Record<string, unknown> = {}) {
  return {
    source: { sourceId: 'fake.inbox', kind: 'fake' },
    trigger: {
      triggerId: 'event-001',
      threadKey: 'thread-a',
      payloadDigest: digest('payload-a'),
      occurredAt: now,
    },
    mandate: {
      scope: ['read-local-fixture'],
      allowedOperations: ['observe'],
      capabilitiesDigest: digest('capabilities'),
    },
    model: { providerId: 'fake', modelId: 'fixture' },
    agentRevisionId: 'rev_fixture',
    configurationRevisionId: 'cfg_fixture',
    ...overrides,
  };
}

function withStore(action: (store: SqliteTaskStore, filename: string, markClosed: () => void) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-platform-'));
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

test('platform parsers reject unknown fields, malformed digests, and canonical topology terms', () => {
  assert.equal(PLATFORM_CONTRACT_VERSION, 2);
  assert.deepEqual(parseWorkControl({ expectedState: 'open' }), { expectedState: 'open' });
  assert.throws(() => parsePairingCreate({ label: 'paired', unexpected: true }), PlatformValidationError);
  assert.throws(() => parseCapabilityWrite({
    kind: 'mcp', name: 'router', status: 'enabled', descriptor: 'local fixture',
  }), PlatformValidationError);
  assert.throws(() => parseSourceEvent({
    sourceId: 'local', threadKey: 'thread-a', payloadDigest: 'not-a-digest',
    occurredAt: now, policy: 'allow', mandateDigest: digest('mandate'),
  }), PlatformValidationError);
  assert.throws(() => parseSecretHandleCreate({
    key: 'fixture', value: '', purpose: 'fixture', allowedAdapter: 'local-bound-fixture',
    destinationBinding: 'local-fixture',
  }), PlatformValidationError);
  assert.equal(rawSha256Digest('value').length, 71);
});

test('platform migration preserves an existing work row and widens its state machine', () => {
  withStore((store, filename, markClosed) => {
    const envelope = store.work.ingestWorkTrigger(parseWorkTriggerRequest(triggerRequest()));
    const workItemId = envelope.workItem.id;
    const pairing = store.platform.createPairing({ label: 'client', challengeDigest: digest('challenge') });
    store.platform.approvePairing({ pairingId: pairing.id, challengeDigest: pairing.challengeDigest });
    store.platform.createToken({
      pairingId: pairing.id,
      name: 'fixture',
      tokenDigest: rawSha256Digest('fixture-token'),
    });
    store.platform.startWork(workItemId, 'open');
    store.close();
    markClosed();

    const reopened = new SqliteTaskStore(filename);
    try {
      const detail = reopened.work.getWorkItemDetail(workItemId);
      assert.equal(detail.version, 2);
      assert.equal(detail.workItem.state, 'paused');
      assert.equal(detail.assignments[0]?.state, 'interrupted');
      assert.ok(reopened.platform.listWorkEvents().some((event) => event.type === 'work.recovered'));
      assert.equal(reopened.platform.hasActiveToken(), true);
      assert.equal(reopened.platform.isTokenActive('fixture-token'), true);
      assert.equal(reopened.platform.isTokenActive('wrong-token'), false);
      assert.equal(detail.assignments[0]?.id, envelope.assignments[0]?.id);
      assert.equal(detail.outbox[0]?.id, envelope.outbox[0]?.id);
      assert.equal(detail.deliveryReceipts[0]?.id, envelope.deliveryReceipts[0]?.id);
    } finally {
      reopened.close();
    }
  });
});

test('write-only handles keep a sealed value out of public state and survive only within one process', () => {
  withStore((store, filename, markClosed) => {
    const handle = store.platform.createSecretHandle({
      key: 'fixture-key',
      value: FIXED_SECRET,
      purpose: 'fixture purpose',
      allowedAdapter: 'local-bound-fixture',
      destinationBinding: 'local-fixture',
    });
    const receipt = store.platform.useSecretHandle({
      handleId: handle.id,
      workItemId: 'work_fixture',
      assignmentId: 'asg_fixture',
      grantRevision: 'grant_fixture',
    });
    assert.equal(receipt.outcome, 'injected');
    assert.equal(handle.valueDigest, rawSha256Digest(FIXED_SECRET));
    const serialized = JSON.stringify({
      handles: store.platform.listSecretHandles(),
      receipts: store.platform.listSecretHandleUseReceipts(),
      events: store.platform.listWorkEvents(),
    });
    assert.doesNotMatch(serialized, new RegExp(FIXED_SECRET));
    const bytes = readFileSync(filename);
    assert.equal(bytes.includes(Buffer.from(FIXED_SECRET, 'utf8')), false);

    const rotated = store.platform.rotateSecretHandle(handle.id, 'rotated-value');
    assert.equal(rotated.secretVersion, 2);
    assert.equal(rotated.valueDigest, rawSha256Digest('rotated-value'));
    store.platform.setSecretHandleStatus(handle.id, 'disabled');
    const denied = store.platform.useSecretHandle({
      handleId: handle.id,
      workItemId: 'work_fixture',
      assignmentId: 'asg_fixture',
      grantRevision: 'grant_fixture',
    });
    assert.equal(denied.outcome, 'denied');
    store.close();
    markClosed();

    const reopened = new SqliteTaskStore(filename);
    try {
      const stale = reopened.platform.useSecretHandle({
        handleId: handle.id,
        workItemId: 'work_fixture',
        assignmentId: 'asg_fixture',
        grantRevision: 'grant_fixture',
      });
      assert.equal(stale.outcome, 'denied');
      assert.equal(reopened.platform.listSecretHandles()[0]?.status, 'disabled');
    } finally {
      reopened.close();
    }
  });
});

test('source policy, capability upsert, and work control have explicit conflicts', () => {
  withStore((store) => {
    const envelope = store.work.ingestWorkTrigger(parseWorkTriggerRequest(triggerRequest()));
    const sourceEvent = store.platform.ingestSourceEvent({
      sourceId: 'local',
      threadKey: 'thread-a',
      payloadDigest: digest('source-payload'),
      occurredAt: now,
      policy: 'deny',
      mandateDigest: digest('mandate'),
    });
    assert.equal(sourceEvent.policy, 'deny');
    assert.equal(store.work.getWorkItemDetail(envelope.workItem.id).workItem.state, 'open');
    store.platform.ingestSourceEvent({
      sourceId: 'local',
      threadKey: 'thread-a',
      payloadDigest: digest('source-payload-allow'),
      occurredAt: '2026-11-11T00:00:01.000Z',
      policy: 'allow',
      mandateDigest: digest('mandate'),
    });
    assert.equal(store.work.getWorkItemDetail(envelope.workItem.id).workItem.state, 'running');
    assert.throws(() => store.platform.startWork(envelope.workItem.id, 'open'), PlatformConflictError);
    store.platform.stopWork(envelope.workItem.id, 'running');
    assert.equal(store.work.getWorkItemDetail(envelope.workItem.id).workItem.state, 'cancelled');

    const first = store.platform.putCapability({
      kind: 'mcp', name: 'fixture-server', status: 'enabled', descriptor: 'local descriptor',
    });
    const updated = store.platform.putCapability({
      kind: 'mcp', name: 'fixture-server', status: 'disabled', descriptor: 'updated descriptor',
    });
    assert.equal(updated.id, first.id);
    assert.equal(updated.status, 'disabled');
    assert.equal(store.platform.listCapabilities().length, 1);
  });
});
