import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BOOTSTRAP_CONFIGURATION_DOCUMENT,
  isConfigurationDocumentV2,
  parseConfigurationDocument,
  type ConfigurationDocument,
} from '../src/runtime/configuration-document.js';
import {
  ConfigurationRevisionNotFoundError,
  SqliteTaskStore,
} from '../src/runtime/task-store.js';

function fixtureDocument(name: string): ConfigurationDocument {
  return parseConfigurationDocument({
    schemaVersion: 1,
    name,
    skills: [],
    policies: [],
    mcpServers: [],
    plugins: [],
    secretRefs: [],
    metadata: { fixture: name },
  });
}

function compositionDocument(name: string): ConfigurationDocument {
  return parseConfigurationDocument({
    schemaVersion: 2,
    name,
    skills: [],
    policies: [],
    mcpServers: [],
    plugins: [],
    secretRefs: [],
    metadata: { fixture: name },
    composition: {
      schemaVersion: 1,
      name: `${name} composition`,
      nodes: [{ id: 'node-a', label: 'First node' }],
      links: [],
      entryNodeIds: ['node-a'],
      metadata: { shape: 'single' },
    },
  });
}

function withDirectory(action: (filename: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-config-store-'));
  try {
    action(path.join(directory, 'runtime.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a new database bootstraps one immutable active revision', () => {
  withDirectory((filename) => {
    let clock = 0;
    const store = new SqliteTaskStore(filename, {
      clock: () => new Date(clock++).toISOString(),
    });
    try {
      const state = store.getConfigurationState();
      assert.equal(state.history.length, 1);
      assert.equal(state.active.id, state.history[0]!.id);
      assert.equal(state.active.document.name, BOOTSTRAP_CONFIGURATION_DOCUMENT.name);
      assert.equal(store.getConfigurationRevision(state.active.id)?.document.name, BOOTSTRAP_CONFIGURATION_DOCUMENT.name);
    } finally {
      store.close();
    }
  });
});

test('appending, no-op applies, reboot, and rollback preserve full history', () => {
  withDirectory((filename) => {
    const first = new SqliteTaskStore(filename, {
      clock: () => '2026-11-08T00:00:00.000Z',
    });
    let bootstrapId = '';
    let firstId = '';
    let secondId = '';
    let compositionId = '';
    try {
      bootstrapId = first.getConfigurationState().active.id;
      const applied = first.applyConfiguration(fixtureDocument('first'));
      firstId = applied.state.active.id;
      assert.equal(applied.changed, true);
      assert.equal(applied.state.history.length, 2);
      assert.equal(first.applyConfiguration(fixtureDocument('first')).changed, false);
      const second = first.applyConfiguration(fixtureDocument('second'));
      secondId = second.state.active.id;
      const composition = first.applyConfiguration(compositionDocument('composed'));
      compositionId = composition.state.active.id;
      assert.equal(composition.state.history.length, 4);
      assert.equal(composition.state.history[0]!.id, compositionId);
      assert.equal(
        isConfigurationDocumentV2(first.getConfigurationRevision(compositionId)?.document ?? fixtureDocument('fallback')),
        true,
      );
      assert.equal(second.state.history[0]!.id, secondId);
      assert.equal(composition.state.active.id, compositionId);
    } finally {
      first.close();
    }

    const reopened = new SqliteTaskStore(filename, {
      clock: () => '2026-11-08T00:00:01.000Z',
    });
    try {
      assert.equal(reopened.getConfigurationState().active.id, compositionId);
      assert.equal(reopened.getConfigurationState().history.length, 4);
      const rollback = reopened.rollbackConfiguration(bootstrapId);
      assert.equal(rollback.changed, true);
      assert.equal(rollback.state.active.id, bootstrapId);
      assert.equal(rollback.state.history.length, 4);
      assert.equal(reopened.rollbackConfiguration(bootstrapId).changed, false);
      assert.equal(reopened.applyConfiguration(fixtureDocument('first')).state.active.id, firstId);
      assert.equal(reopened.getConfigurationState().history.length, 4);
      assert.equal(
        reopened.rollbackConfiguration(secondId).state.active.id,
        secondId,
      );
      assert.throws(
        () => reopened.rollbackConfiguration('cfg_000000000000000000000000'),
        ConfigurationRevisionNotFoundError,
      );
      assert.equal(reopened.getConfigurationRevision('invalid')?.id, undefined);
    } finally {
      reopened.close();
    }
  });
});

test('a second store owner fails fast while the first owner is open', () => {
  withDirectory((filename) => {
    const first = new SqliteTaskStore(filename);
    try {
      assert.throws(() => new SqliteTaskStore(filename), /already owned/);
    } finally {
      first.close();
    }
  });
});
