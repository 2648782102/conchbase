import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTION_FIELD_RULES,
  repairActionFields,
  rulesFor,
} from '../src/runtime/organization-action-contract.js';

/**
 * These fixtures are the anti-regression net for "the model forgot a field".
 *
 * Every prior live failure had the same shape: an action carried everything it
 * could express, and the Runtime rejected it for a field only the Runtime could
 * produce. Enumerating the rules here means adding a new Runtime-owned field
 * without a repair rule fails this test rather than a production run.
 */

const MINIMAL_ACTIONS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  record_intent: { type: 'record_intent', projectId: 'project_alpha', actionCount: 2 },
  create_agent: {
    type: 'create_agent',
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
    delegationId: 'del_alpha',
    agentRevisionId: 'agr_alpha',
    displayName: '工程师',
  },
  report_worker: {
    type: 'report_worker',
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
  },
  request_attention: {
    type: 'request_attention',
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
  },
  answer_attention: {
    type: 'answer_attention',
    projectId: 'project_alpha',
  },
  withdraw_attention: {
    type: 'withdraw_attention',
    projectId: 'project_alpha',
  },
  expire_attention: {
    type: 'expire_attention',
    projectId: 'project_alpha',
  },
});

test('every rule points at an action that has a minimal fixture', () => {
  const missing = Object.keys(ACTION_FIELD_RULES).filter((type) => !(type in MINIMAL_ACTIONS));
  assert.deepEqual(missing, [], `actions with rules need a minimal fixture: ${missing.join(', ')}`);
});

for (const [type, action] of Object.entries(MINIMAL_ACTIONS)) {
  test(`${type} is fully repaired from a minimal action`, () => {
    const repaired = repairActionFields(action, 7);
    assert.equal(repaired.expectedSequence, 7, 'the sequence is always assigned');

    for (const rule of rulesFor(type)) {
      const value = repaired[rule.field];
      switch (rule.filler) {
        case 'runtime-id':
          assert.equal(typeof value, 'string', `${type}.${rule.field} must be filled`);
          assert.match(String(value), /^[a-z][a-z0-9_-]*$/, `${type}.${rule.field} must be an opaque reference`);
          break;
        case 'runtime-digest':
          assert.match(String(value), /^sha256:[a-z0-9:-]+$/, `${type}.${rule.field} must be a digest`);
          break;
        case 'project-scope':
          assert.deepEqual(value, [`project:${String(action.projectId)}`]);
          break;
        case 'default-capability':
          assert.deepEqual(value, ['cap_read_context']);
          break;
        case 'enum':
          assert.equal(value, rule.fallback, `${type}.${rule.field} must fall back`);
          break;
        case 'runtime-sequence':
          assert.equal(value, 7);
          break;
      }
    }
  });
}

test('Runtime-owned values supplied by the model are replaced, not trusted', () => {
  const repaired = repairActionFields({
    type: 'report_worker',
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
    reportId: 'model-invented-id',
    summaryDigest: 'not-a-digest',
    state: 'not-a-state',
  }, 3);
  assert.notEqual(repaired.reportId, 'model-invented-id');
  assert.equal(repaired.summaryDigest, 'sha256:runtime-attested');
  assert.equal(repaired.state, 'ready');
});

test('an invalid capability token is dropped rather than failing the action', () => {
  const repaired = repairActionFields({
    type: 'create_agent',
    projectId: 'p',
    capabilities: ['NOT A TOKEN', 'cap_read_context'],
    scope: [],
  }, 1);
  assert.deepEqual(repaired.capabilities, ['cap_read_context']);
  assert.deepEqual(repaired.scope, ['project:p']);
});

test('an action with no rules is returned with only its sequence added', () => {
  const original = Object.freeze({ type: 'archive_project', projectId: 'p', expectedSequence: 99 });
  const repaired = repairActionFields(original, 4);
  assert.deepEqual(repaired, { type: 'archive_project', projectId: 'p', expectedSequence: 4 });
});

test('repair is deterministic so a replayed plan stays idempotent', () => {
  const action = MINIMAL_ACTIONS.report_worker!;
  const first = repairActionFields(action, 5);
  const second = repairActionFields(action, 5);
  assert.deepEqual(first, second);
});

test('every repaired minimal action is accepted by the real validator', async () => {
  // The contract table is only useful if it agrees with the actual parser.
  // Without this test the table could drift into fiction.
  const { parseOrganizationAction } = await import('../src/runtime/organization-contract.js');
  const rejected: string[] = [];
  for (const [type, action] of Object.entries(MINIMAL_ACTIONS)) {
    const repaired = repairActionFields(action, 1, {
      model: { providerId: 'magpie', modelId: 'fixture/model' },
    });
    try {
      parseOrganizationAction(repaired);
    } catch (cause) {
      rejected.push(`${type}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  assert.deepEqual(rejected, [], `repaired actions must validate:\n${rejected.join('\n')}`);
});

test('a model-supplied agentRevisionId is replaced by a placeholder the executor overwrites', () => {
  // A model cannot know a future `agr_` id. Rejecting its guess fails a plan the
  // Runtime can complete, because createDynamicAgent replaces the field with the
  // real revision id before the action is applied.
  const repaired = repairActionFields({
    type: 'create_agent',
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
    delegationId: 'del_alpha',
    agentRevisionId: 'model-guessed-this',
  }, 2, { model: { providerId: 'magpie', modelId: 'fixture/model' } });
  assert.notEqual(repaired.agentRevisionId, 'model-guessed-this');
  assert.match(String(repaired.agentRevisionId), /^[a-z][a-z0-9_-]*$/);
});
