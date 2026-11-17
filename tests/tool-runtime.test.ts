import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToolRuntime } from '../src/runtime/tool-runtime.js';

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

test('a write never follows a symlink out of the workspace root', async () => {
  // The parent directory is checked with realpath, but the target file itself
  // used to be opened by name: a checked-in symlink turned one write into an
  // overwrite anywhere the user can write. Reads already rejected this path.
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-symlink-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-outside-'));
  try {
    const victim = path.join(outside, 'victim.txt');
    writeFileSync(victim, 'ORIGINAL');
    symlinkSync(victim, path.join(directory, 'innocent.txt'));

    const runtime = await createToolRuntime({ root: directory, allowWrites: true });
    try {
      await assert.rejects(
        async () => runtime.tools.invoke('workspace_write', {
          path: 'innocent.txt', content: 'PWNED',
        }),
        (cause: { code?: string }) => cause.code === 'path_escapes_root',
      );
      assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL');
      await assert.rejects(
        async () => runtime.tools.invoke('workspace_read', { path: 'innocent.txt' }),
        (cause: { code?: string }) => cause.code === 'path_escapes_root',
      );
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a large file read is bounded by the requested window, not the file size', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-window-'));
  try {
    // 4 MiB of payload: reading it whole would allocate the file per call.
    writeFileSync(path.join(directory, 'big.log'), `${'x'.repeat(1024)}\n`.repeat(4096));
    const runtime = await createToolRuntime({ root: directory });
    try {
      const slice = await runtime.tools.invoke('workspace_read', { path: 'big.log', maxBytes: 200 });
      assert.ok(Buffer.byteLength(slice.summary) <= 200);
      assert.match(slice.summary, /Continue with offset=200\./);
      const tail = await runtime.tools.invoke('workspace_read', {
        path: 'big.log', maxBytes: 200, offset: 4096 * 1025 - 8,
      });
      assert.ok(tail.summary.length > 0);
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
