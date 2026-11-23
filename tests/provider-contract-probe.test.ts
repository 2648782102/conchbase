import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runProviderContract } from '../src/cli/provider-contract-probe.js';
import { categorizeError } from '../src/runtime/error-categories.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = path.join(repositoryRoot, 'scripts/provider-contract.mjs');

function runProbe(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function collector() {
  const lines: string[] = [];
  return {
    lines,
    stream: { write(value: string) { lines.push(String(value).replace(/\n$/, '')); return true; } },
  };
}

test('the live provider probe refuses a missing endpoint with an actionable message', () => {
  const result = runProbe({ CONCHBASE_PROVIDER_ENDPOINTS: '', CONCHBASE_MAGPIE_URL: '' });

  assert.notEqual(result.status, 0, 'an unconfigured probe must fail');
  assert.match(
    result.stderr + result.stdout,
    /CONCHBASE_PROVIDER_ENDPOINTS|CONCHBASE_MAGPIE_URL/,
    'the failure must name the operator configuration to set',
  );
  assert.doesNotMatch(result.stderr + result.stdout, /\n\s+at /, 'a config error must not print a stack trace');
});

test('the live provider probe redacts token-shaped values from every output line', () => {
  const result = runProbe({
    CONCHBASE_PROVIDER_ENDPOINTS: JSON.stringify({
      'openai-compatible': {
        baseUrl: 'http://127.0.0.1:1',
        appKey: 'sk-this-token-must-never-print',
      },
    }),
    CONCHBASE_MAGPIE_URL: 'http://127.0.0.1:2',
  });

  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /sk-this-token-must-never-print/);
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /unavailable/, 'the failed catalog request must still report a category');
});

test('the provider probe exercises the catalog, a stream, and a classified failure', async () => {
  const stdout = collector();
  const stderr = collector();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string } : {};
    const authorization = new Headers(init?.headers).get('authorization');
    assert.equal(authorization, 'Bearer sk-secret-should-not-print');
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'probe-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (body.model === 'conchbase-unknown-model-probe') {
      return new Response(JSON.stringify({ error: { message: 'unknown model' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'PROBE_OK' } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const status = await runProviderContract({
    env: {
      ...process.env,
      CONCHBASE_PROVIDER_ENDPOINTS: JSON.stringify({
        'openai-compatible': {
          baseUrl: 'http://127.0.0.1:3425',
          appKey: 'sk-secret-should-not-print',
        },
      }),
      CONCHBASE_MODEL: 'probe-model',
    } as NodeJS.ProcessEnv,
    fetchImpl,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(status, 0, stderr.lines.join('\n'));
  assert.match(stdout.lines.join('\n'), /catalog\s+1 model\(s\)/);
  assert.match(stdout.lines.join('\n'), /streaming\s+\d+ms; PROBE_OK/);
  assert.match(stdout.lines.join('\n'), /failure-category\s+validation/);
  assert.doesNotMatch([...stdout.lines, ...stderr.lines].join('\n'), /sk-secret-should-not-print/);
});

test('the probe classifies failures with the canonical Runtime categories', async () => {
  assert.equal(categorizeError({ kind: 'invalid-request' }), 'validation');
  assert.equal(categorizeError({ kind: 'upstream-failure' }), 'provider');
  assert.equal(categorizeError({ kind: 'unavailable' }), 'unavailable');

  const stdout = collector();
  const stderr = collector();
  let call = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'probe-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    call += 1;
    if (call === 1) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'PROBE_OK' } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({ error: { message: 'unknown model' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  const status = await runProviderContract({
    env: {
      ...process.env,
      CONCHBASE_PROVIDER_ENDPOINTS: '',
      CONCHBASE_MAGPIE_URL: 'http://127.0.0.1:3425',
      CONCHBASE_MODEL: 'probe-model',
    } as NodeJS.ProcessEnv,
    fetchImpl,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(status, 0, stderr.lines.join('\n'));
  assert.match(stdout.lines.join('\n'), /failure-category\s+validation/);
  assert.doesNotMatch(stdout.lines.join('\n'), /failure-category\s+invalid-request/);
});

test('the probe completes a real loopback HTTP catalog, stream, and failure round trip', async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const model = body.length > 0 ? JSON.parse(body).model as string : '';
      requests.push(`${request.method} ${request.url} ${model}`);
      const authorization = request.headers.authorization ?? '';
      assert.equal(authorization, 'Bearer sk-fixture-token');
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'probe-model' }] }));
        return;
      }
      if (model === 'conchbase-unknown-model-probe') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'unknown model' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'PROBE_OK' } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const stdout = collector();
    const stderr = collector();
    const status = await runProviderContract({
      env: {
        ...process.env,
        CONCHBASE_PROVIDER_ENDPOINTS: JSON.stringify({
          'openai-compatible': {
            baseUrl: `http://127.0.0.1:${address.port}`,
            appKey: 'sk-fixture-token',
          },
        }),
        CONCHBASE_MODEL: 'probe-model',
      } as NodeJS.ProcessEnv,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(status, 0, stderr.lines.join('\n'));
    assert.match(stdout.lines.join('\n'), /catalog\s+1 model\(s\)/);
    assert.match(stdout.lines.join('\n'), /streaming\s+\d+ms; PROBE_OK/);
    assert.match(stdout.lines.join('\n'), /failure-category\s+validation/);
    assert.deepEqual(
      requests.map((entry) => entry.replace(/^POST \/v1\/chat\/completions /, 'POST ')),
      ['GET /v1/models ', 'POST probe-model', 'POST conchbase-unknown-model-probe'],
    );
    assert.doesNotMatch([...stdout.lines, ...stderr.lines].join('\n'), /sk-fixture-token/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
