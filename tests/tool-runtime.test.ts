import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToolRuntime } from '../src/runtime/tool-runtime.js';
import { combineToolProviders, ToolRejectedError } from '../src/runtime/tool-provider.js';

/**
 * Every provider merges through `combineToolProviders`, so that is the one
 * place a malformed id can be caught for all of them. Before this, the pattern
 * lived in the plugin manifest and built-ins were never checked.
 */
test('a malformed tool id is refused at the merge point', () => {
  const provider = {
    list: () => [{ id: 'Not Valid!', version: 1 as const, description: 'x', sideEffect: 'read' as const }],
    has: () => true,
    invoke: () => { throw new Error('not called'); },
  };
  assert.throws(
    () => combineToolProviders([provider]),
    (cause: unknown) => cause instanceof ToolRejectedError && cause.code === 'invalid_tool_id',
  );
});

test('write tools are absent unless explicitly enabled', async () => {
  // This assembly decides the tool surface. A regression here would either
  // expose writes that were never granted, or silently remove reads.
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-runtime-'));
  try {
    writeFileSync(path.join(directory, 'note.txt'), 'hello');
    const readOnly = await createToolRuntime({ root: directory });
    const readIds = readOnly.tools.list().map((tool) => tool.id).sort();
    assert.ok(readIds.includes('workspace_read'), 'reads are always available');
    assert.ok(!readIds.includes('workspace_write'), 'writes require an explicit opt-in');
    await readOnly.close();

    const withWrites = await createToolRuntime({ root: directory, allowWrites: true });
    const writeIds = withWrites.tools.list().map((tool) => tool.id).sort();
    assert.ok(writeIds.includes('workspace_write'), 'enabling writes adds the write tool');
    assert.ok(writeIds.includes('workspace_read'), 'writes do not remove reads');
    await withWrites.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('web_extract is exposed only when HTTP tools are enabled', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-runtime-http-'));
  try {
    const readOnly = await createToolRuntime({ root: directory });
    const readIds = readOnly.tools.list().map((tool) => tool.id);
    assert.equal(readIds.includes('web_extract'), false);
    await readOnly.close();

    const withHttp = await createToolRuntime({ root: directory, enableHttp: true });
    const httpIds = withHttp.tools.list().map((tool) => tool.id);
    assert.ok(httpIds.includes('http_fetch'));
    assert.ok(httpIds.includes('web_extract'));
    await withHttp.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('skills are empty when no directory is configured', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-runtime-skills-'));
  try {
    const runtime = await createToolRuntime({ root: directory });
    assert.deepEqual([...runtime.skills.skills], []);
    assert.equal(runtime.skills.instructions, '');
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a configured skill directory is loaded into the runtime', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-runtime-load-'));
  try {
    const skills = path.join(directory, 'skills');
    mkdirSync(skills, { recursive: true });
    mkdirSync(path.join(skills, 'writing'), { recursive: true });
    writeFileSync(path.join(skills, 'writing', 'SKILL.md'), [
      '---',
      'name: writing',
      'description: 写作规范',
      '---',
      '先给结论。',
    ].join('\n'));
    const runtime = await createToolRuntime({ root: directory, skillsDirectory: skills });
    assert.equal(runtime.skills.skills.length, 1);
    assert.equal(runtime.skills.skills[0]?.name, 'writing');
    assert.match(runtime.skills.instructions, /先给结论/);
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
