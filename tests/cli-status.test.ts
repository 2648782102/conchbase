import assert from 'node:assert/strict';
import test from 'node:test';
import { probeRuntimeStatus } from '../src/runtime/runtime-probe.js';

test('probe reports down when nothing listens', async () => {
  const result = await probeRuntimeStatus({
    baseUrl: 'http://127.0.0.1:1',
    fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof globalThis.fetch,
  });
  assert.equal(result.running, false);
  assert.equal(result.healthy, false);
  assert.ok(result.detail.length > 0);
});

test('probe reports a healthy runtime with its version', async () => {
  const result = await probeRuntimeStatus({
    baseUrl: 'http://127.0.0.1:4318',
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/health')) {
        return new Response(JSON.stringify({ status: 'ok', service: 'conchbase', apiVersion: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/v1/runtime')) {
        return new Response(JSON.stringify({ name: 'Conchbase', version: '1.0.0', state: 'ready' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof globalThis.fetch,
  });
  assert.equal(result.running, true);
  assert.equal(result.healthy, true);
  assert.equal(result.version, '1.0.0');
  assert.equal(result.state, 'ready');
});

test('probe reports running-but-unhealthy when health fails', async () => {
  const result = await probeRuntimeStatus({
    baseUrl: 'http://127.0.0.1:4318',
    fetch: (async () => new Response('nope', { status: 503 })) as typeof globalThis.fetch,
  });
  assert.equal(result.running, true);
  assert.equal(result.healthy, false);
});
