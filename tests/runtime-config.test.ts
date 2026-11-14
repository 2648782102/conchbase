import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

test('uses loopback defaults', () => {
  assert.deepEqual(loadRuntimeConfig({}), {
    host: '127.0.0.1',
    port: 4318,
    databasePath: '.conchbase/runtime.sqlite',
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'workbuddy/blind-model-h',
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
      allowAuthenticatedRemoteBinding: false,
    },
  );
  assert.equal(loadRuntimeConfig({ CONCHBASE_HOST: 'localhost' }).host, 'localhost');
  assert.equal(loadRuntimeConfig({}).organizationIntentModel, undefined);
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
