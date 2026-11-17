import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SubprocessPluginClient } from '../src/runtime/subprocess-plugin.js';

/**
 * Subprocess plugin boundary.
 *
 * The process boundary gives fault isolation, not a sandbox. These fixtures
 * verify the parts that are enforceable here: no inherited environment, a line
 * protocol, bounded responses, timeouts, and no crash propagation.
 */
const script = (body: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cb-plugin-script-'));
  const file = path.join(directory, 'plugin.mjs');
  writeFileSync(file, body);
  return file;
};

test('a plugin receives one invoke request and returns a bounded result', async () => {
  const file = script(`
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\\n').filter(Boolean)) {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ callId: request.callId, ok: true, summary: 'echo:' + request.toolId }) + '\\n');
      }
    });
  `);
  const client = new SubprocessPluginClient({
    command: process.execPath,
    args: [file],
    envAllowlist: [],
  });
  try {
    await client.start();
    const result = await client.invoke('demo_read', { path: 'a.txt' });
    assert.equal(result.ok, true);
    assert.equal(result.summary, 'echo:demo_read');
    assert.match(result.digest, /^plugin_/);
  } finally {
    client.close();
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('the child does not inherit arbitrary environment variables', async () => {
  const file = script(`
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\\n').filter(Boolean)) {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          callId: request.callId,
          ok: true,
          summary: JSON.stringify({
            hasSecret: typeof process.env.CONCHBASE_TEST_SECRET !== 'undefined',
            hasPath: typeof process.env.PATH !== 'undefined',
          }),
        }) + '\\n');
      }
    });
  `);
  const previous = process.env.CONCHBASE_TEST_SECRET;
  process.env.CONCHBASE_TEST_SECRET = 'must-not-leak';
  const client = new SubprocessPluginClient({
    command: process.execPath,
    args: [file],
    envAllowlist: [],
  });
  try {
    await client.start();
    const result = await client.invoke('demo_read', {});
    assert.deepEqual(JSON.parse(result.summary), { hasSecret: false, hasPath: true });
  } finally {
    client.close();
    rmSync(path.dirname(file), { recursive: true, force: true });
    if (previous === undefined) delete process.env.CONCHBASE_TEST_SECRET;
    else process.env.CONCHBASE_TEST_SECRET = previous;
  }
});

test('invalid JSON from the plugin becomes a bounded tool failure', async () => {
  const file = script(`
    process.stdin.on('data', () => process.stdout.write('not json\\n'));
  `);
  const client = new SubprocessPluginClient({ command: process.execPath, args: [file], envAllowlist: [] });
  try {
    await client.start();
    await assert.rejects(async () => client.invoke('demo_read', {}), /invalid JSON/);
  } finally {
    client.close();
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('a child crash is reported and does not crash the Runtime', async () => {
  const file = script(`
    process.stdin.on('data', () => process.exit(7));
  `);
  const client = new SubprocessPluginClient({ command: process.execPath, args: [file], envAllowlist: [] });
  try {
    await client.start();
    await assert.rejects(async () => client.invoke('demo_read', {}), /exited/);
    assert.doesNotThrow(() => client.close());
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('a silent plugin call times out without hanging the Runtime', async () => {
  const file = script(`process.stdin.on('data', () => {});`);
  const client = new SubprocessPluginClient({
    command: process.execPath,
    args: [file],
    envAllowlist: [],
    callTimeoutMs: 100,
  });
  try {
    await client.start();
    await assert.rejects(async () => client.invoke('demo_read', {}), /timed out/);
  } finally {
    client.close();
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('oversized replies fail the call instead of flooding the Runtime', async () => {
  const file = script(`
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\\n').filter(Boolean)) {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ callId: request.callId, ok: true, summary: 'x'.repeat(5000) }) + '\\n');
      }
    });
  `);
  const client = new SubprocessPluginClient({
    command: process.execPath,
    args: [file],
    envAllowlist: [],
    maxResultBytes: 100,
  });
  try {
    await client.start();
    await assert.rejects(async () => client.invoke('demo_read', {}), /too much output/);
  } finally {
    client.close();
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('an unlimited result size still bounds the buffer', async () => {
  // `maxResultBytes` is optional and the guard compared against `undefined * 4`,
  // which is NaN, so every comparison was false and one endless line grew the
  // buffer until the process died.
  const file = script(`process.stdout.write('x'.repeat(2_000_000));`);
  const client = new SubprocessPluginClient({ command: process.execPath, args: [file], envAllowlist: [] });
  try {
    await client.start();
    await assert.rejects(async () => client.invoke('demo_read', {}), /too much output|exited/);
  } finally {
    client.close();
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('a plugin that cannot spawn fails the start instead of hanging', async () => {
  const client = new SubprocessPluginClient({
    command: 'conchbase-plugin-that-does-not-exist',
    args: [],
    envAllowlist: [],
    startTimeoutMs: 500,
  });
  try {
    await assert.rejects(async () => client.start());
  } finally {
    client.close();
  }
});
