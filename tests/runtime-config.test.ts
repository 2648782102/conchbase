import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

test('uses loopback defaults', () => {
  assert.deepEqual(loadRuntimeConfig({}), {
    host: '127.0.0.1',
    port: 4318,
    databasePath: '.conchbase/runtime.sqlite',
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'workbuddy/blind-model-h',
    executionMode: 'restricted',
    workspaceRoot: process.cwd(),
    loopBudget: { maxIterations: 6, maxToolCallsPerTurn: 4, deadlineMs: 120_000 },
    workerSliceIterations: 0,
    projectIdleMs: 30 * 60 * 1000,
    globalActiveWork: 8,
    perProjectActiveWork: 2,
    allowAuthenticatedRemoteBinding: false,
  });
});

test('accepts configured loopback host and decimal port', () => {
  assert.deepEqual(
    loadRuntimeConfig({ CONCHBASE_HOST: '::1', CONCHBASE_PORT: '5000' }),
    {
      host: '::1',
      port: 5000,
      databasePath: '.conchbase/runtime.sqlite',
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'workbuddy/blind-model-h',
      executionMode: 'restricted',
      workspaceRoot: process.cwd(),
      loopBudget: { maxIterations: 6, maxToolCallsPerTurn: 4, deadlineMs: 120_000 },
      workerSliceIterations: 0,
      projectIdleMs: 30 * 60 * 1000,
      globalActiveWork: 8,
      perProjectActiveWork: 2,
      allowAuthenticatedRemoteBinding: false,
    },
  );
  assert.equal(loadRuntimeConfig({ CONCHBASE_HOST: 'localhost' }).host, 'localhost');
  assert.equal(loadRuntimeConfig({}).organizationIntentModel, undefined);
});

test('accepts operator loop budgets within the documented ranges', () => {
  const budget = loadRuntimeConfig({
    CONCHBASE_MAX_ITERATIONS: '30',
    CONCHBASE_MAX_TOOL_CALLS_PER_TURN: '8',
    CONCHBASE_LOOP_DEADLINE_MS: '600000',
  }).loopBudget;
  assert.deepEqual(budget, { maxIterations: 30, maxToolCallsPerTurn: 8, deadlineMs: 600_000 });
  assert.deepEqual(loadRuntimeConfig({}).loopBudget, {
    maxIterations: 6,
    maxToolCallsPerTurn: 4,
    deadlineMs: 120_000,
  });
});

test('rejects loop budgets outside the documented ranges', () => {
  for (const env of [
    { CONCHBASE_MAX_ITERATIONS: '0' },
    { CONCHBASE_MAX_ITERATIONS: '65' },
    { CONCHBASE_MAX_ITERATIONS: '2.5' },
    { CONCHBASE_MAX_ITERATIONS: 'many' },
    { CONCHBASE_MAX_TOOL_CALLS_PER_TURN: '0' },
    { CONCHBASE_MAX_TOOL_CALLS_PER_TURN: '17' },
    { CONCHBASE_LOOP_DEADLINE_MS: '999' },
    { CONCHBASE_LOOP_DEADLINE_MS: '1800001' },
  ]) {
    assert.throws(() => loadRuntimeConfig(env), /must be an integer between/, JSON.stringify(env));
  }
});

test('rejects non-loopback hosts', () => {
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_HOST: '0.0.0.0' }),
    /loopback binding/,
  );
});

test('rejects invalid ports before the server starts', () => {
  for (const port of ['', '0', '65536', '3.5', '1e3', '0x10', 'abc']) {
    assert.throws(
      () => loadRuntimeConfig({ CONCHBASE_PORT: port }),
      /CONCHBASE_PORT must be an integer/,
      `expected ${JSON.stringify(port)} to be rejected`,
    );
  }
});

test('accepts configured local provider and database values', () => {
  const config = loadRuntimeConfig({
    CONCHBASE_DB: '/tmp/conchbase-test.sqlite',
    CONCHBASE_MAGPIE_URL: 'http://localhost:3425/',
    CONCHBASE_MAGPIE_APP_KEY: 'magpie-conchbase',
    CONCHBASE_MODEL: 'fixture/model',
    CONCHBASE_ORGANIZATION_INTENT_MODEL: 'fixture/organization-parser',
    CONCHBASE_BOSS_MODEL: 'fixture/boss-chat',
  });
  assert.equal(config.databasePath, '/tmp/conchbase-test.sqlite');
  assert.equal(config.magpieAppKey, 'magpie-conchbase');
  assert.equal(config.defaultModel, 'fixture/model');
  assert.equal(config.organizationIntentModel, 'fixture/organization-parser');
  assert.equal(config.bossModel, 'fixture/boss-chat');
});

test('uses the configured default model for Boss conversation when no override is set', () => {
  const config = loadRuntimeConfig({ CONCHBASE_MODEL: 'fixture/model' });
  assert.equal(config.defaultModel, 'fixture/model');
  assert.equal(config.bossModel, undefined);
});

test('rejects non-loopback provider URLs and malformed app keys', () => {
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_MAGPIE_URL: 'https://example.com' }),
    /CONCHBASE_MAGPIE_URL must be a loopback HTTP URL/,
  );
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_MAGPIE_APP_KEY: 'secret' }),
    /CONCHBASE_MAGPIE_APP_KEY has an invalid format/,
  );
});

test('enabling writes requires an explicit workspace root', () => {
  // Writing into the process working directory let a worker overwrite the
  // Runtime's own repository README during a live run.
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_ALLOW_TOOL_WRITES: '1' }),
    /requires CONCHBASE_WORKSPACE_ROOT/,
  );
  const configured = loadRuntimeConfig({
    CONCHBASE_ALLOW_TOOL_WRITES: '1',
    CONCHBASE_WORKSPACE_ROOT: '/tmp/agent-workspace',
  });
  assert.equal(configured.allowToolWrites, true);
  assert.equal(configured.workspaceRoot, '/tmp/agent-workspace');
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_WORKSPACE_ROOT: 'relative/path' }),
    /must be an absolute path/,
  );
});

test('startup creates the configured workspace root before tools use it', () => {
  // A worker whose root does not exist can list nothing and write nothing: it
  // reports not_found for every path and produces no output. The Runtime must
  // create the root at startup rather than relying on the operator to do it.
  const sources = [
    readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8'),
  ];
  for (const source of sources) {
    assert.match(
      source,
      /mkdirSync\(config\.workspaceRoot, \{ recursive: true \}\)/,
      'every Runtime entry point must create the workspace root',
    );
  }
});

test('project idle policy is operator configuration with a bounded range', () => {
  // ADR 0081: convergence is a retention decision, so a model, task, or client
  // must never be able to shorten it into an immediate archive.
  assert.equal(loadRuntimeConfig({}).projectIdleMs, 30 * 60 * 1000);
  assert.equal(loadRuntimeConfig({ CONCHBASE_PROJECT_IDLE_MS: '60000' }).projectIdleMs, 60_000);
  assert.equal(loadRuntimeConfig({ CONCHBASE_PROJECT_IDLE_MS: '86400000' }).projectIdleMs, 86_400_000);
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_PROJECT_IDLE_MS: '59999' }),
    /CONCHBASE_PROJECT_IDLE_MS must be an integer between 60000 and 86400000/,
  );
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_PROJECT_IDLE_MS: 'soon' }),
    /CONCHBASE_PROJECT_IDLE_MS/,
  );
});

test('git tools are off unless explicitly enabled', () => {
  // ADR 0095: these execute a subprocess, so the default surface must not
  // include them. The flag mirrors CONCHBASE_ALLOW_TOOL_WRITES.
  assert.equal(loadRuntimeConfig({}).enableGitTools, undefined);
  assert.equal(loadRuntimeConfig({ CONCHBASE_ENABLE_GIT_TOOLS: '1' }).enableGitTools, true);
  assert.equal(loadRuntimeConfig({ CONCHBASE_ENABLE_GIT_TOOLS: 'true' }).enableGitTools, undefined);
  assert.equal(loadRuntimeConfig({ CONCHBASE_ENABLE_GIT_TOOLS: '0' }).enableGitTools, undefined);
});

test('global scheduling capacity is operator configuration with bounded ranges', () => {
  assert.equal(loadRuntimeConfig({}).globalActiveWork, 8);
  assert.equal(loadRuntimeConfig({}).perProjectActiveWork, 2);
  assert.equal(loadRuntimeConfig({ CONCHBASE_GLOBAL_ACTIVE_WORK: '4' }).globalActiveWork, 4);
  assert.equal(loadRuntimeConfig({ CONCHBASE_PER_PROJECT_ACTIVE_WORK: '3' }).perProjectActiveWork, 3);
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_GLOBAL_ACTIVE_WORK: '0' }),
    /CONCHBASE_GLOBAL_ACTIVE_WORK/,
  );
  assert.throws(
    () => loadRuntimeConfig({ CONCHBASE_PER_PROJECT_ACTIVE_WORK: '17' }),
    /CONCHBASE_PER_PROJECT_ACTIVE_WORK/,
  );
});
