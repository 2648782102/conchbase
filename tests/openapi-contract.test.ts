import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import {
  HEALTH_RESPONSE_FIXTURE,
  RUNTIME_RESPONSE_FIXTURE,
} from './fixtures/runtime-fixtures.js';

const openApiPath = fileURLToPath(new URL('../docs/openapi.yaml', import.meta.url));

function readOpenApi(): string {
  return readFileSync(openApiPath, 'utf8');
}

function assertSchemaFields(schemaName: string, fields: readonly string[]): void {
  const spec = readOpenApi();
  const start = spec.indexOf(`  ${schemaName}:`);
  assert.notEqual(start, -1, `${schemaName} must exist in docs/openapi.yaml`);

  const remainingSpec = spec.slice(start + 3);
  const nextSchema = /\n {4}[A-Za-z]/.exec(remainingSpec);
  const section = spec.slice(
    start,
    nextSchema === null ? undefined : start + 3 + nextSchema.index,
  );
  assert.match(section, /type: object/);
  assert.match(section, /additionalProperties: false/);

  const required = /required: \[([^\]]+)\]/.exec(section)?.[1]
    ?.split(',')
    .map((field) => field.trim());
  assert.deepEqual(required, [...fields]);

  for (const field of fields) {
    assert.match(section, new RegExp(`\\n {8}${field}:`));
  }
}

function assertExactObject(
  value: unknown,
  requiredFields: readonly string[],
): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  assert.deepEqual(Object.keys(value as object).sort(), [...requiredFields].sort());
}

test('docs/openapi.yaml declares the versioned task, event, and status contract', () => {
  const spec = readOpenApi();

  assert.match(spec, /^openapi: 3\.1\.0$/m);
  assert.deepEqual(
    [...spec.matchAll(/^ {2}(\/v1\/[^:]+):$/gm)].map((match) => match[1]),
    [
      '/v1/health',
      '/v1/runtime',
      '/v1/models',
      '/v1/model-catalog',
      '/v1/agents',
      '/v1/agents/{agentId}',
      '/v1/agents/{agentId}/duplicate',
      '/v1/agents/{agentId}/archive',
      '/v1/agents/{agentId}/revisions',
      '/v1/agents/{agentId}/revisions/apply',
      '/v1/agents/default',
      '/v1/tasks',
      '/v1/tasks/{taskId}',
      '/v1/tasks/{taskId}/cancel',
      '/v1/tasks/{taskId}/retry',
      '/v1/events',
      '/v1/configuration',
      '/v1/configuration/revisions',
      '/v1/configuration/revisions/{revisionId}',
      '/v1/configuration/validate',
      '/v1/configuration/apply',
      '/v1/tool-requests',
      '/v1/tool-requests/{requestId}',
      '/v1/tool-requests/{requestId}/approval',
      '/v1/provider-observations/tool-calls',
      '/v1/work/triggers',
      '/v1/work/items',
      '/v1/work/items/{workItemId}',
      '/v1/work/delivery-receipts',
      '/v1/work/delivery-receipts/{receiptId}/decision',
      '/v1/work/assignments/{assignmentId}/reconcile',
      '/v1/work/items/{workItemId}/start',
      '/v1/work/items/{workItemId}/stop',
      '/v1/work/items/{workItemId}/complete',
      '/v1/work/events',
      '/v1/auth/pairings',
      '/v1/auth/pairings/approve',
      '/v1/auth/pairings/{pairingId}/revoke',
      '/v1/auth/tokens',
      '/v1/auth/tokens/{tokenId}/revoke',
      '/v1/sources/local/events',
      '/v1/capabilities',
      '/v1/secret-handles',
      '/v1/secret-handles/{handleId}/rotate',
      '/v1/secret-handles/{handleId}/status',
      '/v1/secret-handles/{handleId}/use',
      '/v1/secret-handles/use-receipts',
    ],
  );
  assert.match(spec, /\$ref: '#\/components\/schemas\/Health'/);
  assert.match(spec, /\$ref: '#\/components\/schemas\/RuntimeStatus'/);
  assertSchemaFields('Health', ['status', 'service', 'apiVersion']);
  assertSchemaFields('RuntimeStatus', ['name', 'version', 'state', 'capabilities']);
  assert.match(spec, /CreateTaskRequest:[\s\S]*?allOf:/);
  assertSchemaFields('AgentReference', ['providerId', 'modelId']);
  assertSchemaFields('ProviderModel', ['providerId', 'modelId', 'reference', 'displayName', 'capabilities']);
  assertSchemaFields('AgentProfile', ['name', 'instructions', 'providerId', 'modelId']);
  assertSchemaFields('AgentRevision', ['id', 'name', 'instructions', 'providerId', 'modelId', 'createdAt']);
  assertSchemaFields('AgentRecord', ['id', 'currentRevisionId', 'archived', 'isDefault', 'current']);
  assertSchemaFields('Agent', ['id', 'currentRevisionId', 'archived', 'isDefault', 'current', 'revisions']);
  assertSchemaFields('Task', [
    'id',
    'prompt',
    'model',
    'configurationRevisionId',
    'state',
    'attempt',
    'output',
    'partialOutput',
    'error',
  ]);
  assert.match(spec.slice(spec.indexOf('    Task:'), spec.indexOf('    TaskEnvelope:')), /agentRevisionId:/);
  assertSchemaFields('RuntimeEvent', [
    'sequence',
    'id',
    'taskId',
    'type',
    'state',
    'configurationRevisionId',
    'attempt',
    'data',
  ]);
  assertSchemaFields('ConfigurationDocumentV1', [
    'schemaVersion',
    'name',
    'skills',
    'policies',
    'mcpServers',
    'plugins',
    'secretRefs',
    'metadata',
  ]);
  assertSchemaFields('ConfigurationDocumentV2', [
    'schemaVersion',
    'name',
    'skills',
    'policies',
    'mcpServers',
    'plugins',
    'secretRefs',
    'metadata',
    'composition',
  ]);
  assertSchemaFields('ConfigurationComposition', [
    'schemaVersion',
    'name',
    'nodes',
    'links',
    'entryNodeIds',
    'metadata',
  ]);
  assertSchemaFields('ConfigurationRevision', ['id', 'document', 'appliedAt']);
  assertSchemaFields('ApplyConfigurationResponse', [
    'changed',
    'activeRevisionId',
    'revision',
    'revisions',
  ]);
  assert.match(spec, /enum: \[inline, file, registry, env\]/);
  assert.doesNotMatch(spec, /enum: \[[^\]]*\burl\b/);
  assert.match(spec, /ApplyConfigurationRequest:[\s\S]*?oneOf:/);
  assert.match(spec, /^  version: 1\.0\.0$/m);
  assert.match(spec, /compositionDocumentId/);
  assert.match(spec, /compositionNodeId/);
  assertSchemaFields('CreateProviderToolCallObservation', ['version', 'provider', 'payload']);
  assertSchemaFields('ProviderToolCallObservation', [
    'version',
    'kind',
    'provider',
    'providerToolCallId',
    'toolCall',
    'argumentsDigest',
  ]);
  assertSchemaFields('ProviderToolCallObservationResponse', ['observation']);
  assertSchemaFields('CreateWorkTriggerRequest', [
    'source',
    'trigger',
    'mandate',
    'model',
    'agentRevisionId',
    'configurationRevisionId',
  ]);
  assertSchemaFields('WorkEnvelope', [
    'version',
    'created',
    'workItemCreated',
    'contextOnly',
    'trigger',
    'thread',
    'mandate',
    'workItem',
    'assignments',
    'outbox',
    'deliveryReceipts',
    'events',
  ]);
  assertSchemaFields('WorkItemDetail', [
    'version',
    'workItem',
    'thread',
    'mandate',
    'assignments',
    'outbox',
    'deliveryReceipts',
  ]);
  assertSchemaFields('CreateToolRequest', [
    'taskId',
    'attempt',
    'compositionNodeId',
    'toolCall',
  ]);
  assertSchemaFields('ToolRequest', [
    'version',
    'id',
    'taskId',
    'attempt',
    'configurationRevisionId',
    'compositionDocumentId',
    'compositionNodeId',
    'toolName',
    'argumentsDigest',
    'idempotencyKey',
    'status',
    'createdAt',
    'approval',
  ]);
  assertSchemaFields('ToolRequestDecisionRequest', ['decision', 'reason']);
  assert.match(spec, /^  version: 1\.0\.0$/m);
  assert.match(spec, /tool-approval-ledger/);
  assert.match(spec, /write-only-secret-handles/);
  assert.match(spec, /write-only-secret-handles/);
  assert.match(spec, /provider-tool-call-observation records/);
  assert.match(spec, /No tool is executed/);
  assert.match(spec, /- tool\.requested/);
  assert.match(spec, /- tool\.approval_required/);
  assert.match(spec, /- tool\.approved/);
  assert.match(spec, /- tool\.rejected/);
  assert.doesNotMatch(spec, /- tool\.executed/);
  assert.doesNotMatch(spec, /- tool\.replayed/);
  assert.doesNotMatch(spec, /- tool\.denied/);
  assert.doesNotMatch(spec, /- tool\.failed/);
  assert.match(spec, /Public tool ledger events carry toolRequestId/);
});

test('exact response fixtures match the documented read-only JSON schema shapes', () => {
  assertExactObject(HEALTH_RESPONSE_FIXTURE, ['status', 'service', 'apiVersion']);
  assert.equal(HEALTH_RESPONSE_FIXTURE.status, 'ok');
  assert.equal(HEALTH_RESPONSE_FIXTURE.service, 'conchbase');
  assert.equal(HEALTH_RESPONSE_FIXTURE.apiVersion, 1);

  assertExactObject(RUNTIME_RESPONSE_FIXTURE, [
    'name',
    'version',
    'state',
    'capabilities',
  ]);
  assert.equal(RUNTIME_RESPONSE_FIXTURE.name, 'Conchbase');
  assert.equal(typeof RUNTIME_RESPONSE_FIXTURE.version, 'string');
  assert.equal(RUNTIME_RESPONSE_FIXTURE.state, 'ready');
  assert.ok(Array.isArray(RUNTIME_RESPONSE_FIXTURE.capabilities));
  assert.ok(RUNTIME_RESPONSE_FIXTURE.capabilities.every((item) => typeof item === 'string'));
});

test('live injected responses equal the documented response fixtures', async () => {
  const app = createApp({ logger: false });

  try {
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });

    assert.equal(health.statusCode, 200);
    assert.equal(runtime.statusCode, 200);
    assert.deepEqual(health.json(), HEALTH_RESPONSE_FIXTURE);
    assert.deepEqual(runtime.json(), RUNTIME_RESPONSE_FIXTURE);
  } finally {
    await app.close();
  }
});
