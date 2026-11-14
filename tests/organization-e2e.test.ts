import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/http/create-app.js';
import { createTaskService } from '../src/runtime/task-service.js';
import { BossModeService } from '../src/runtime/boss-mode-service.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const pagurusOrganizationClientPath = path.join(repositoryRoot, 'pagurus/src/shared/api/organization.ts');
const pairedCheckoutAvailable = existsSync(pagurusOrganizationClientPath);

function sseBody(output: string): string {
  const frame = JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: null }] });
  return `data: ${frame}\n\ndata: [DONE]\n\n`;
}

function fakeProvider(responses: Map<string, string>) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.url?.endsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'fixture-model', display_name: 'Fixture' }] }));
        return;
      }
      if (request.url?.endsWith('/v1/chat/completions')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: { content?: string }[] };
        const prompt = body.messages?.at(-1)?.content ?? '';
        const output = [...responses.entries()].find(([key]) => prompt.includes(key))?.[1] ?? 'done';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseBody(output));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unknown fake gateway route.' }));
    });
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Fake gateway did not listen.'));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function pagurusModuleUrl(relativePath: string): string {
  return pathToFileURL(path.join(repositoryRoot, 'pagurus', relativePath)).href;
}

test('dual-repository Boss-mode product loop uses Pagurus clients over live loopback', { skip: !pairedCheckoutAvailable }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-boss-e2e-'));
  const responses = new Map<string, string>([
    ['alpha', 'alpha complete'],
    ['beta', 'ATTENTION: need confirmation'],
  ]);
  const gateway = fakeProvider(responses);
  const gatewayOrigin = await listen(gateway);
  const originalFetch = globalThis.fetch;
  let runtimeOrigin = '';
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requested = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url;
    const target = requested.startsWith('/v1/') ? `${runtimeOrigin}${requested}` : requested;
    return originalFetch(target, init);
  }) as typeof globalThis.fetch;

  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: gatewayOrigin,
    defaultModel: 'fixture-model',
    fetch: originalFetch,
  });
  const bossMode = new BossModeService(service.store.organization, service);
  const app = createApp({ logger: false, taskService: service, bossModeService: bossMode });
  runtimeOrigin = await app.listen({ host: '127.0.0.1', port: 0 });

  try {
    const client = await import(pagurusModuleUrl('src/shared/api/organization.ts')) as {
      getOrganizationSession(signal?: AbortSignal): Promise<{
        projects: readonly { id: string; state: string }[];
        workers: readonly { id: string; state: string }[];
        reports: readonly { id: string; state: string }[];
        attentionRequests: readonly { id: string; state: string; expectedVersion: number }[];
      }>;
      submitOrganizationIntent(intent: { text: string; idempotencyKey: string }): Promise<{ intentId: string }>;
      decideOrganizationAttention(
        attentionId: string,
        kind: 'answer' | 'withdraw',
        expectedVersion: number,
      ): Promise<unknown>;
      getOrganizationEvents(): Promise<{ events: readonly { type: string }[] }>;
    };

    const alphaIntent = await client.submitOrganizationIntent({
      text: 'Start project alpha and hire worker alpha.',
      idempotencyKey: 'e2e-alpha',
    });
    const betaIntent = await client.submitOrganizationIntent({
      text: 'Start project beta and hire worker beta.',
      idempotencyKey: 'e2e-beta',
    });
    assert.notEqual(alphaIntent.intentId, betaIntent.intentId);

    let session = await client.getOrganizationSession();
    assert.equal(session.projects.length, 2);
    assert.equal(session.workers.length, 2);
    assert.equal(session.reports.length, 2);
    assert.equal(session.attentionRequests.some((request) => request.state === 'open'), true);
    assert.equal(session.workers.every((worker) => ['running', 'reporting', 'blocked'].includes(worker.state)), true);

    const attention = session.attentionRequests.find((request) => request.state === 'open')!;
    await client.decideOrganizationAttention(attention.id, 'answer', attention.expectedVersion);

    await client.submitOrganizationIntent({
      text: 'Archive project alpha and offboard its worker.',
      idempotencyKey: 'e2e-archive-alpha',
    });
    session = await client.getOrganizationSession();
    assert.equal(session.projects.filter((project) => project.state === 'archived').length, 1);
    assert.equal(session.workers.some((worker) => worker.state === 'offboarded'), true);

    await client.submitOrganizationIntent({
      text: 'Resume project alpha after revalidation.',
      idempotencyKey: 'e2e-resume-alpha',
    });
    session = await client.getOrganizationSession();
    assert.equal(session.projects.filter((project) => project.state === 'resumed').length, 1);

    const events = await client.getOrganizationEvents();
    assert.equal(events.events.some((event) => event.type === 'organization.intent_recorded'), true);
    assert.equal(events.events.some((event) => event.type === 'organization.report_recorded'), true);
    assert.equal(events.events.some((event) => event.type === 'organization.attention_answered'), true);
    assert.equal(events.events.some((event) => event.type === 'organization.project_archived'), true);
    assert.equal(events.events.some((event) => event.type === 'organization.project_resumed'), true);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    await service.stop();
    gateway.closeAllConnections();
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
