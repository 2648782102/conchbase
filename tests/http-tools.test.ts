import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_HTTP_BYTES,
  createBuiltinHttpTools,
  isForbiddenAddress,
} from '../src/runtime/http-tools.js';
import { createBoundedResourceFetcher } from '../src/runtime/http-fetch-boundary.js';

/**
 * An HTTP tool without an SSRF boundary is a request forwarder with extra steps.
 *
 * The checks below are the ones an attacker actually tries first: metadata
 * services, the Runtime's own API on loopback, a hostname that resolves inward,
 * a redirect that lands inward, and IPv6 forms of the same addresses.
 */
const publicResolve = async () => ['93.184.216.34'];

function tools(over: {
  fetch?: typeof globalThis.fetch;
  resolve?: (host: string) => Promise<readonly string[]>;
  allowPrivateNetworks?: boolean;
  maxBytes?: number;
} = {}) {
  return createBuiltinHttpTools({
    resolve: over.resolve ?? publicResolve,
    ...(over.fetch ? { fetch: over.fetch } : {}),
    ...(over.allowPrivateNetworks === true ? { allowPrivateNetworks: true } : {}),
    ...(over.maxBytes ? { maxBytes: over.maxBytes } : {}),
  });
}

test('loopback, private, link-local, and metadata addresses are all refused', () => {
  for (const address of [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.51.100.1', '203.0.113.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ]) {
    assert.equal(isForbiddenAddress(address), true, `${address} must be forbidden`);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) {
    assert.equal(isForbiddenAddress(address), false, `${address} must be allowed`);
  }
});

test('a literal loopback URL is refused before any request is made', async () => {
  let called = false;
  const provider = tools({
    fetch: (async () => { called = true; return new Response('x'); }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'http://127.0.0.1:4318/v1/tasks' }),
    /private, loopback, or link-local/i,
  );
  assert.equal(called, false, 'the request must never be sent');
});

test('a hostname that resolves inward is refused, not just its literal form', async () => {
  let called = false;
  const provider = tools({
    // The classic bypass: a public-looking name that resolves to loopback.
    resolve: async () => ['127.0.0.1'],
    fetch: (async () => { called = true; return new Response('x'); }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'http://internal.example.com/' }),
    /private, loopback/i);
  assert.equal(called, false);
});

test('a redirect into loopback is refused on the hop, not followed', async () => {
  const seen: string[] = [];
  const provider = tools({
    fetch: (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      // A public host is free to answer with this.
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:4318/v1/tasks' },
      });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'https://example.com/' }),
    /private, loopback/i);
  assert.deepEqual(seen, ['https://example.com/'], 'the second hop must never be requested');
});

test('credentials in a URL are refused', async () => {
  const provider = tools();
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'https://user:pass@example.com/' }),
    (cause: unknown) => (cause as { code?: string }).code === 'url_contains_credentials',
  );
});

test('only GET and HEAD are accepted, and only http(s)', async () => {
  const provider = tools();
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'file:///etc/passwd' }),
    /http and https/);
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'https://example.com/', method: 'POST' }),
    /GET and HEAD/,
  );
});

test('a textual response is returned and bounded', async () => {
  const body = 'a'.repeat(MAX_HTTP_BYTES + 500);
  const provider = tools({
    maxBytes: 1_024,
    fetch: (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof globalThis.fetch,
  });
  const result = await provider.invoke('http_fetch', { url: 'https://example.com/' });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.match(String(result.summary), /truncated at 1024 bytes/);
  assert.ok(String(result.summary).length < body.length);
});

test('a non-textual response is refused rather than dumped into context', async () => {
  const provider = tools({
    fetch: (async () => new Response('binary', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'https://example.com/a.bin' }),
    /content-type/);
});

test('the shared fetch boundary bounds bytes before parsing', async () => {
  const fetchResource = createBoundedResourceFetcher({
    resolve: publicResolve,
    maxBytes: 1_024,
    fetch: (async () => new Response('x'.repeat(4_096), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof globalThis.fetch,
  });
  const resource = await fetchResource('https://example.com/page', 'GET');
  assert.equal(resource.truncated, true);
  assert.equal(resource.body.length, 1_024);
  assert.equal(resource.status, 200);
});

test('an HTTP error surfaces the status instead of pretending success', async () => {
  const provider = tools({
    fetch: (async () => new Response('not found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'https://example.com/missing' }),
    /HTTP 404/);
});

test('too many redirects is a refusal, not a loop', async () => {
  const provider = tools({
    fetch: (async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/again' },
    })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'https://example.com/' }),
    (cause: unknown) => (cause as { code?: string }).code === 'too_many_redirects',
  );
});

test('the operator can allow private networks, and only the operator', async () => {
  const provider = tools({
    allowPrivateNetworks: true,
    fetch: (async () => new Response('lan data', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof globalThis.fetch,
  });
  const result = await provider.invoke('http_fetch', { url: 'http://192.168.1.10:8080/status' });
  assert.equal(result.ok, true);
  assert.match(String(result.summary), /lan data/);
});

test('HEAD reports the status without reading a body', async () => {
  const provider = tools({
    fetch: (async () => new Response(null, {
      status: 204,
      headers: { 'content-type': 'text/plain' },
    })) as typeof globalThis.fetch,
  });
  const result = await provider.invoke('http_fetch', { url: 'https://example.com/', method: 'HEAD' });
  assert.equal(result.ok, true);
  assert.match(String(result.summary), /204/);
});

test('the tool is external, so policy approves it at the standard level', () => {
  const definitions = tools().list();
  const fetchTool = definitions.find((definition) => definition.id === 'http_fetch');
  assert.equal(fetchTool?.sideEffect, 'external');
});

test('http_fetch keeps returning raw textual bodies with evidence', async () => {
  const provider = tools({
    fetch: (async () => new Response('raw body', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof globalThis.fetch,
  });
  const result = await provider.invoke('http_fetch', { url: 'https://example.com/article' });
  assert.equal(result.ok, true);
  assert.equal(String(result.summary), 'raw body');
  assert.deepEqual(result.evidence?.facts, {
    url: 'https://example.com/article',
    status: 200,
    contentType: 'text/plain',
    bytes: 8,
    truncated: false,
    redirects: 0,
  });
});

test('http_fetch still refuses a redirect into loopback', async () => {
  const seen: string[] = [];
  const provider = tools({
    fetch: (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:4318/v1/tasks' },
      });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    async () => provider.invoke('http_fetch', { url: 'https://example.com/' }),
    /private, loopback/i,
  );
  assert.deepEqual(seen, ['https://example.com/']);
});
