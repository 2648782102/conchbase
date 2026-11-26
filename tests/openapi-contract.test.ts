import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import {
  AGENT_CHAT_MESSAGE_REQUEST_FIELDS,
  AGENT_CHAT_CONTRACT_VERSION,
} from '../src/runtime/agent-chat.js';
import {
  APPLY_CONFIGURATION_REQUEST_FIELDS,
} from '../src/http/routes/v1/configuration.js';
import {
  CREATE_TASK_MODEL_OVERRIDE_FIELDS,
  CREATE_TASK_REQUEST_FIELDS,
} from '../src/http/routes/v1/tasks.js';
import {
  CREATE_TOOL_REQUEST_FIELDS,
  TOOL_REQUEST_DECISION_FIELDS,
  TOOL_REQUEST_TOOL_CALL_FIELDS,
} from '../src/http/routes/v1/tool-requests.js';
import {
  SCHEDULE_PATCH_FIELDS,
} from '../src/http/routes/v1/schedules.js';
import {
  SCHEDULE_INPUT_FIELDS,
} from '../src/runtime/schedule.js';
import {
  AGENT_CHAT_PATHS_FIXTURE,
  CONVERSATION_PATHS_FIXTURE,
  EXECUTION_PATHS_FIXTURE,
  EXECUTION_RUN_PATHS_FIXTURE,
  HEALTH_RESPONSE_FIXTURE,
  ORGANIZATION_PATHS_FIXTURE,
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

function schemaSection(schemaName: string): string {
  const spec = readOpenApi();
  const start = spec.indexOf(`  ${schemaName}:`);
  assert.notEqual(start, -1, `${schemaName} must exist in docs/openapi.yaml`);
  const remainingSpec = spec.slice(start + 3);
  const nextSchema = /\n {4}[A-Za-z]/.exec(remainingSpec);
  return spec.slice(start, nextSchema === null ? undefined : start + 3 + nextSchema.index);
}

function schemaPropertyNames(schemaName: string): string[] {
  return [...schemaSection(schemaName).matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):$/gm)]
    .map((match) => match[1]!);
}

test('components declare each section once, and every $ref resolves', () => {
  /*
   * The document had two `components.schemas` blocks for a long time. YAML
   * keeps the last one, so 23 schemas were silently invisible to any reader
   * while still looking present in the file. A duplicate section header is
   * never intentional here, and a broken `$ref` is worse than a missing field:
   * a generator fails at build time with no clue which change caused it.
   */
  const spec = readOpenApi();
  for (const section of ['schemas', 'parameters', 'responses']) {
    assert.equal(
      [...spec.matchAll(new RegExp(`^ {2}${section}:$`, 'gm'))].length,
      1,
      `components.${section} must be declared exactly once`,
    );
  }

  const declared = (section: string): Set<string> => {
    const start = spec.indexOf(`\n  ${section}:\n`);
    assert.notEqual(start, -1, `components.${section} must exist`);
    const rest = spec.slice(start + 1);
    const nextTop = /\n {2}[a-zA-Z][A-Za-z]*:\n/.exec(rest);
    const body = rest.slice(0, nextTop === null ? undefined : nextTop.index);
    return new Set([...body.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):$/gm)].map((match) => match[1]!));
  };

  for (const section of ['schemas', 'parameters', 'responses']) {
    const names = declared(section);
    const referenced = new Set(
      [...spec.matchAll(new RegExp(`\\$ref: '#/components/${section}/([^']+)'`, 'g'))]
        .map((match) => match[1]!),
    );
    const missing = [...referenced].filter((name) => !names.has(name) && !name.includes('/'));
    assert.deepEqual(missing.sort(), [], `components.${section} is missing referenced entries`);
  }
});

test('the Agent Chat request schema names every field the Runtime accepts', () => {
  /*
   * This is the guard the last change lacked. `postMessage` grew
   * `attachments`, `reasoningEffort`, and `modelOverride` while
   * `AgentChatMessageRequest` kept `additionalProperties: false` and only the
   * original two fields, so a generated client was told the new fields did not
   * exist. Comparing the exported list to the document makes that drift fail
   * here instead of in a consumer.
   */
  const section = schemaSection('AgentChatMessageRequest');
  const documented = /required: \[([^\]]+)\]/.exec(section)?.[1]
    ?.split(',')
    .map((field) => field.trim());
  assert.deepEqual(documented, ['text', 'idempotencyKey']);

  const properties = [...section.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...properties].sort(),
    [...AGENT_CHAT_MESSAGE_REQUEST_FIELDS].sort(),
    'docs/openapi.yaml AgentChatMessageRequest must document exactly the accepted fields',
  );
});

test('the create task request schema names every field the route accepts', () => {
  assert.deepEqual(
    schemaPropertyNames('CreateTaskRequest').sort(),
    [...CREATE_TASK_REQUEST_FIELDS].sort(),
    'docs/openapi.yaml CreateTaskRequest must document exactly the accepted fields',
  );
  assert.deepEqual(
    schemaPropertyNames('AgentReference').sort(),
    [...CREATE_TASK_MODEL_OVERRIDE_FIELDS].sort(),
    'docs/openapi.yaml AgentReference must document every accepted model override field',
  );
});

test('the tool request schemas name every field the routes accept', () => {
  assert.deepEqual(
    schemaPropertyNames('CreateToolRequest').sort(),
    [...CREATE_TOOL_REQUEST_FIELDS].sort(),
  );
  assert.deepEqual(
    schemaPropertyNames('ToolCallProposal').sort(),
    [...TOOL_REQUEST_TOOL_CALL_FIELDS].sort(),
  );
  assert.deepEqual(
    schemaPropertyNames('ToolRequestDecisionRequest').sort(),
    [...TOOL_REQUEST_DECISION_FIELDS].sort(),
  );
});

test('the configuration apply schema names every field the route accepts', () => {
  assert.deepEqual(
    schemaPropertyNames('ApplyConfigurationRequest').sort(),
    [...APPLY_CONFIGURATION_REQUEST_FIELDS].sort(),
  );
});

test('the schedule schemas name every field the routes accept', () => {
  assert.deepEqual(
    schemaPropertyNames('CreateScheduleRequest').sort(),
    [...SCHEDULE_INPUT_FIELDS].sort(),
  );
  assert.deepEqual(
    schemaPropertyNames('UpdateScheduleRequest').sort(),
    [...SCHEDULE_PATCH_FIELDS].sort(),
  );
});

test('the Agent Chat message schema carries the model that wrote each reply', () => {
  const section = schemaSection('AgentChatMessage');
  assert.match(section, /^ {8}modelReference:$/m);
  assert.match(
    section,
    /required: \[[^\]]*\bmodelReference\b[^\]]*\]/,
    'modelReference is always present on a message, as null when no model wrote it',
  );
  assert.match(readOpenApi(), new RegExp(`AgentChatVersion:\\n {6}type: string\\n {6}const: '${AGENT_CHAT_CONTRACT_VERSION.replaceAll('.', '\\.')}'`));
});

test('docs/openapi.yaml declares the versioned task, event, and status contract', () => {
  const spec = readOpenApi();

  assert.match(spec, /^openapi: 3\.1\.0$/m);
  assert.deepEqual(
    [...spec.matchAll(/^ {2}(\/v1\/[^:]+):$/gm)].map((match) => match[1]),
    [
      '/v1/health',
      '/v1/runtime',
      '/v1/operations/data',
      '/v1/operations/backup',
      '/v1/operations/support-bundle',
      '/v1/operations/diagnostics',
      '/v1/models',
      '/v1/model-catalog',
      '/v1/agents',
      '/v1/agents/{agentId}',
      '/v1/agents/{agentId}/duplicate',
      '/v1/agents/{agentId}/archive',
      '/v1/agents/{agentId}/revisions',
      '/v1/agents/{agentId}/revisions/apply',
      '/v1/agents/capability-grants',
      '/v1/agents/default',
      '/v1/tasks',
      '/v1/tasks/{taskId}',
      '/v1/tasks/{taskId}/cancel',
      '/v1/tasks/{taskId}/retry',
      '/v1/tasks/{taskId}/approval',
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
      ...ORGANIZATION_PATHS_FIXTURE,
      ...CONVERSATION_PATHS_FIXTURE,
      ...AGENT_CHAT_PATHS_FIXTURE,
      ...EXECUTION_PATHS_FIXTURE,
      ...EXECUTION_RUN_PATHS_FIXTURE,
      '/v1/schedules',
      '/v1/schedules/{scheduleId}',
      '/v1/memory',
      '/v1/memory/{memoryId}',
      /*
       * The `@` picker's data source. Read-only paths and sizes; registered
       * only when the Runtime has a workspace root.
       */
      '/v1/workspace/files',
    ],
  );
  assertSchemaFields('WorkspaceFileEntry', ['path', 'bytes', 'directory']);
  assert.match(spec, /\$ref: '#\/components\/schemas\/Health'/);
  assert.match(spec, /\$ref: '#\/components\/schemas\/RuntimeStatus'/);
  assertSchemaFields('Health', ['status', 'service', 'apiVersion']);
  assertSchemaFields('RuntimeStatus', [
    'name',
    'version',
    'state',
    'capabilities',
  ]);
  assert.match(spec, /executionContract:/);
  assert.match(spec, /executionPaths:/);
  assert.match(spec, /CreateTaskRequest:[\s\S]*?allOf:/);
  assertSchemaFields('AgentReference', ['providerId', 'modelId']);
  assertSchemaFields('ProviderModel', ['providerId', 'modelId', 'reference', 'displayName', 'capabilities']);
  assertSchemaFields('AgentProfile', ['name', 'instructions', 'providerId', 'modelId']);
  assert.match(spec, /^ {8}grantedCapabilities:$/m, 'AgentProfile must document optional capability grants');
  assertSchemaFields('AgentRevision', ['id', 'name', 'instructions', 'providerId', 'modelId', 'grantedCapabilities', 'createdAt']);
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
  assert.match(spec, /^  version: 1\.1\.0$/m);
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
  assert.match(spec, /^  version: 1\.1\.0$/m);
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
  assertSchemaFields('OrganizationIntent', ['text', 'idempotencyKey', 'expectedSequence']);
  assertSchemaFields('OrganizationIntentRequest', ['intent']);
  assertSchemaFields('OrganizationIntentResult', ['version', 'intentId', 'state', 'expectedSequence']);
  assertSchemaFields('OrganizationSessionView', [
    'version',
    'bossSession',
    'projects',
    'delegations',
    'workers',
    'reports',
    'attentionRequests',
  ]);
  assertSchemaFields('OrganizationAttentionDecision', ['expectedVersion']);
  assertSchemaFields('OrganizationEventPage', ['version', 'events', 'nextCursor', 'hasMore']);
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
  const app = createApp({
    logger: false,
    taskService: { store: { organization: {} } } as never,
  });

  try {
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });

    assert.equal(health.statusCode, 200);
    assert.equal(runtime.statusCode, 200);
    assert.deepEqual(health.json(), HEALTH_RESPONSE_FIXTURE);
    assert.deepEqual(runtime.json(), {
      ...RUNTIME_RESPONSE_FIXTURE,
      capabilities: runtime.json().capabilities,
      ...(runtime.json().organizationContract
        ? {
          organizationContract: runtime.json().organizationContract,
          organizationPaths: runtime.json().organizationPaths,
        }
        : {}),
      ...(runtime.json().executionContract
        ? {
          executionContract: runtime.json().executionContract,
          executionPaths: runtime.json().executionPaths,
        }
        : {}),
      ...(runtime.json().executionRunContract
        ? {
          executionRunContract: runtime.json().executionRunContract,
          executionRunPaths: runtime.json().executionRunPaths,
        }
        : {}),
      ...(runtime.json().conversationContract
        ? {
          conversationContract: runtime.json().conversationContract,
          conversationPaths: runtime.json().conversationPaths,
        }
        : {}),
      ...(runtime.json().agentChatContract
        ? {
          agentChatContract: runtime.json().agentChatContract,
          agentChatPaths: runtime.json().agentChatPaths,
        }
        : {}),
      executionMode: runtime.json().executionMode,
      permissionLevel: runtime.json().permissionLevel,
      executionModeIsLegacy: runtime.json().executionModeIsLegacy,
    });
  } finally {
    await app.close();
  }
});
