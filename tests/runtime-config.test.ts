import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

test('uses loopback defaults', () => {
  assert.deepEqual(loadRuntimeConfig({}), { host: '127.0.0.1', port: 4318 });
});

test('accepts configured loopback host and decimal port', () => {
  assert.deepEqual(
    loadRuntimeConfig({ CONCHBASE_HOST: '::1', CONCHBASE_PORT: '5000' }),
    { host: '::1', port: 5000 },
  );
  assert.deepEqual(
    loadRuntimeConfig({ CONCHBASE_HOST: 'localhost' }),
    { host: 'localhost', port: 4318 },
  );
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
