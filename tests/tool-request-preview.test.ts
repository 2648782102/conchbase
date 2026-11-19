import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolRequestPreview, PREVIEW_LIMITS } from '../src/runtime/tool-request-preview.js';

test('a workspace write yields target, effect, and a bounded diff', () => {
  const preview = buildToolRequestPreview({
    toolName: 'workspace_write',
    arguments: { path: 'notes/a.txt', content: 'hello world\n' },
    existing: 'old\n',
  });
  assert.ok(preview);
  assert.equal(preview?.targetLabel, 'notes/a.txt', 'relative, not absolute');
  assert.equal(preview?.effect, 'modify');
  assert.equal(preview?.reversible, true);
  assert.ok((preview?.summary ?? '').length > 0);
  assert.ok((preview?.diff ?? '').includes('+hello world'));
});

test('creating a new file is reported as create, not modify', () => {
  const preview = buildToolRequestPreview({
    toolName: 'workspace_write',
    arguments: { path: 'new.txt', content: 'x' },
    existing: null,
  });
  assert.equal(preview?.effect, 'create');
});

test('overwriting reports the previous size in the risk note', () => {
  const preview = buildToolRequestPreview({
    toolName: 'workspace_write',
    arguments: { path: 'a.txt', content: 'yyyy', overwrite: true },
    existing: 'xx',
  });
  assert.equal(preview?.effect, 'modify');
  assert.match(preview?.riskNote ?? '', /replace|overwrite|覆盖|替换/i);
});

test('secret-like content never appears in the preview', () => {
  const preview = buildToolRequestPreview({
    toolName: 'workspace_write',
    arguments: { path: 'k.txt', content: 'api_key=sk-live-abcdefghijklmnopqrstuvwx' },
    existing: null,
  });
  assert.equal(JSON.stringify(preview).includes('sk-live-abcdefghijklmnopqrstuvwx'), false);
});

test('a large body is truncated with an explicit marker', () => {
  const preview = buildToolRequestPreview({
    toolName: 'workspace_write',
    arguments: { path: 'big.txt', content: 'x'.repeat(50_000) },
    existing: null,
  });
  assert.ok((preview?.diff ?? '').length <= PREVIEW_LIMITS.diffBytes + 100);
  assert.match(preview?.diff ?? '', /truncated|截断/i);
});

test('an unknown or read-only tool yields no preview', () => {
  assert.equal(buildToolRequestPreview({ toolName: 'workspace_read', arguments: { path: 'a' }, existing: null }), null);
  assert.equal(buildToolRequestPreview({ toolName: 'something_else', arguments: {}, existing: null }), null);
});

test('absolute paths are not echoed as the target label', () => {
  const preview = buildToolRequestPreview({
    toolName: 'workspace_write',
    arguments: { path: '/etc/passwd', content: 'x' },
    existing: null,
  });
  assert.equal(preview, null, 'an out-of-workspace path must not produce a preview');
});

test('the API attaches a preview to a pending write request and keeps it on read', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createApp } = await import('../src/http/create-app.js');
  const { createTaskService } = await import('../src/runtime/task-service.js');

  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-prev-api-'));
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model',
    fetch: (async () => new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch,
  });
  const app = createApp({ logger: false, taskService: service });
  try {
    const applied = service.applyConfiguration({
      document: {
        schemaVersion: 2,
        name: 'preview fixture',
        skills: [], policies: [], mcpServers: [], plugins: [], secretRefs: [],
        metadata: { fixture: 'preview' },
        composition: {
          schemaVersion: 1,
          name: 'preview composition',
          nodes: [{ id: 'n1', label: 'Node one' }],
          links: [],
          entryNodeIds: ['n1'],
          metadata: { shape: 'single' },
        },
      },
    } as never);
    const task = service.store.createTask({
      id: 'task_prev_1', prompt: 'x', model: 'fixture/model',
      configurationRevisionId: applied.state.active.id, attempt: 1,
    });
    const created = await app.inject({
      method: 'POST', url: '/v1/tool-requests',
      payload: {
        taskId: task.id, attempt: 1, compositionNodeId: 'n1',
        toolCall: { toolName: 'workspace_write', arguments: { path: 'a.txt', content: 'hi' } },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const preview = created.json().request.preview;
    assert.ok(preview, 'a pending write carries a preview');
    assert.equal(preview.targetLabel, 'a.txt');

    const read = await app.inject({ method: 'GET', url: `/v1/tool-requests/${created.json().request.id}` });
    assert.equal(read.json().request.preview?.targetLabel, 'a.txt', 'the read path keeps the preview');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});
