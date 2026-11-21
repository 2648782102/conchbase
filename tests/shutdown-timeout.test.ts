import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

const catalog: ModelCatalogClient = {
  async listModels() {
    return [{ id: 'fixture/chat-model', displayName: 'Fixture' }];
  },
};

/**
 * A shutdown that can hang is a shutdown the operator cannot rely on.
 *
 * Aborting a controller only asks the loop to stop. A provider call that never
 * settles — a gateway that accepted the connection and then went silent — kept
 * `stop()` waiting forever. The process could not exit while still holding the
 * database lock, which blocks the next start with a message about ownership
 * rather than about the hung request that caused it.
 */
test('stop() returns after its timeout even when a provider call never settles', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-stop-timeout-'));
  let entered: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fetchImpl = (async () => {
    entered?.();
    // A promise that ignores the abort signal entirely: the worst case.
    return new Promise<Response>(() => undefined);
  }) as typeof globalThis.fetch;

  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/chat-model',
      fetch: fetchImpl,
    },
    catalog,
  );
  try {
    const task = service.createTask({ prompt: 'hang' });
    service.startTask(task.id);
    await started;

    const began = Date.now();
    await service.stop({ timeoutMs: 1_000 });
    const elapsed = Date.now() - began;

    assert.ok(elapsed < 4_000, `stop() must be bounded, took ${elapsed}ms`);
    assert.equal(service.shutdownTimedOut, true, 'giving up is recorded, not hidden');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a normal shutdown does not report a timeout', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-stop-clean-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/chat-model' },
    catalog,
  );
  try {
    await service.stop({ timeoutMs: 1_000 });
    assert.equal(service.shutdownTimedOut, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
