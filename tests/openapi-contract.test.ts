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
    ],
  );
  assert.match(spec, /\$ref: '#\/components\/schemas\/Health'/);
  assert.match(spec, /\$ref: '#\/components\/schemas\/RuntimeStatus'/);
  assertSchemaFields('Health', ['status', 'service', 'apiVersion']);
  assertSchemaFields('RuntimeStatus', ['name', 'version', 'state', 'capabilities']);
  assertSchemaFields('CreateTaskRequest', ['prompt']);
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
  assert.match(spec, /^  version: 0\.5\.0$/m);
  assert.match(spec, /compositionDocumentId/);
  assert.match(spec, /compositionNodeId/);
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
