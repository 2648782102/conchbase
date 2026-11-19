import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import { createBuiltinWriteTools } from '../src/runtime/write-tools.js';
import { createGitReadTools } from '../src/runtime/git-tools.js';

test('the built-in tool set exposes no arbitrary shell or exec tool', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-shell-'));
  try {
    const providers = [
      createBuiltinReadTools({ root }),
      createBuiltinWriteTools({ root }),
      createGitReadTools({ root }),
    ];
    const ids = providers.flatMap((provider) => provider.list().map((tool) => tool.id));
    for (const forbidden of ['shell', 'exec', 'bash', 'run_command', 'spawn', 'system']) {
      assert.equal(ids.includes(forbidden), false, `no ${forbidden} tool may exist`);
    }
    // Git tools are fixed read-only commands, not a command runner.
    const gitIds = createGitReadTools({ root }).list().map((tool) => tool.id);
    for (const id of gitIds) {
      assert.match(id, /^git_(status|diff|log)$/, `unexpected git tool ${id}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git tools only accept the fixed, read-only shapes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-shell-'));
  try {
    const git = createGitReadTools({ root });
    const def = git.list().find((tool) => tool.id === 'git_status');
    assert.ok(def);
    assert.equal(def?.sideEffect, 'read');
    // There is no free-form "command" argument to smuggle a shell invocation.
    const schema = JSON.stringify(def?.parameters ?? {});
    assert.equal(/command|args|exec/i.test(schema), false, 'no command-shaped argument');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
