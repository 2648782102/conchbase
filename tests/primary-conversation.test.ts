import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { createOrganization, applyOrganizationAction, type OrganizationSnapshot } from '../src/runtime/organization-contract.js';
import {
  PRIMARY_CONVERSATION_PUBLIC_PATHS,
  PrimaryConversationService,
  projectPrimaryConversation,
} from '../src/runtime/primary-conversation.js';

function snapshotWithBossIntent(text = 'Start project atlas and hire worker planner.'): {
  snapshot: OrganizationSnapshot;
  intentId: string;
} {
  const intentId = 'int_fixture';
  let snapshot = createOrganization('primary_conversation');
  snapshot = applyOrganizationAction(snapshot, {
    type: 'open_project',
    expectedSequence: 0,
    projectId: 'project_atlas',
    originTriggerId: intentId,
  });
  snapshot = applyOrganizationAction(snapshot, {
    type: 'activate_project',
    expectedSequence: 1,
    projectId: 'project_atlas',
  });
  snapshot = applyOrganizationAction(snapshot, {
    type: 'record_intent',
    expectedSequence: 2,
    projectId: 'project_atlas',
    intentId,
    bodyDigest: `sha256:${'a'.repeat(64)}`,
    actionCount: 2,
  });
  return { snapshot, intentId };
}

test('primary conversation projects one coherent ordered thread from Runtime facts', () => {
  const { snapshot, intentId } = snapshotWithBossIntent();
  const service = new PrimaryConversationService();
  service.recordIntentText(intentId, 'Start project atlas and hire worker planner.');
  const view = service.view(snapshot);
  assert.equal(view.version, '1.4.0');
  assert.equal(view.bossSessionId, snapshot.bossSession.id);
  assert.equal(view.messages.length, 2);
  assert.deepEqual(view.messages.map((message) => message.kind), [
    'boss_acknowledgement',
    'user_message',
  ]);
  assert.equal(view.messages[1]?.body, 'Start project atlas and hire worker planner.');
  assert.deepEqual(PRIMARY_CONVERSATION_PUBLIC_PATHS, [
    '/v1/organization/conversation',
    '/v1/organization/conversation/messages',
  ]);
  assert.doesNotMatch(JSON.stringify(view), /sk-|Bearer|privateKey|runtime\.sqlite|\.conchbase\//i);
});

test('conversation cursors are bounded, idempotent, and reject unknown cursors', () => {
  const { snapshot } = snapshotWithBossIntent();
  const service = new PrimaryConversationService();
  const first = service.page(snapshot, { limit: 1 });
  assert.equal(first.messages.length, 1);
  assert.equal(first.hasMore, true);
  const second = service.page(snapshot, { after: first.nextCursor, limit: 100 });
  assert.equal(second.messages[0]?.id, first.messages.at(-1)?.id === undefined
    ? undefined
    : service.page(snapshot, { limit: 2 }).messages[1]?.id);
  assert.equal(second.messages.every((message) => message.id !== first.messages[0]?.id), true);
  assert.throws(() => service.page(snapshot, { after: 'msg_unknown' }), /unknown/);
  assert.throws(() => service.page(snapshot, { limit: 201 }), /limit/);
});

test('duplicate events and system status stay bounded and never leak raw task output', () => {
  const { snapshot } = snapshotWithBossIntent();
  const service = new PrimaryConversationService();
  const projected = projectPrimaryConversation({
    snapshot,
    taskStates: [{ taskId: 'task_alpha', state: 'succeeded', attempt: 1 }],
  });
  assert.equal(new Set(projected.map((message) => message.id)).size, projected.length);
  assert.equal(projected.some((message) => message.kind === 'system_status'), false);
  assert.doesNotMatch(JSON.stringify(service.view(snapshot)), /prompt|output|sk-|Bearer|privateKey/i);
});

test('1.4.0 HTTP contract publishes conversation discovery and no private state', async () => {
  const { snapshot, intentId } = snapshotWithBossIntent();
  const service = new PrimaryConversationService();
  service.recordIntentText(intentId, 'Start project atlas and hire worker planner.');
  const organizationStore = {
    get: () => snapshot,
    initialize: () => snapshot,
    apply: () => snapshot,
    events: () => snapshot.events,
  };
  const app = createApp({
    logger: false,
    organizationStore,
    conversationService: service,
  });
  try {
    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });
    assert.equal(runtime.json().conversationContract, '1.4.0');
    assert.equal(runtime.json().conversationPaths, 2);
    const conversation = await app.inject({ method: 'GET', url: '/v1/organization/conversation' });
    assert.equal(conversation.statusCode, 200);
    assert.equal(conversation.json().messages.length, 2);
    const messages = await app.inject({
      method: 'GET',
      url: '/v1/organization/conversation/messages?limit=1',
    });
    assert.equal(messages.statusCode, 200);
    assert.equal(messages.json().messages.length, 1);
    const badCursor = await app.inject({
      method: 'GET',
      url: '/v1/organization/conversation/messages?after=msg_unknown',
    });
    assert.equal(badCursor.statusCode, 400);
    assert.doesNotMatch(JSON.stringify(conversation.json()), /sk-|Bearer|privateKey|runtime\.sqlite|\.conchbase\//i);
  } finally {
    await app.close();
  }
});
