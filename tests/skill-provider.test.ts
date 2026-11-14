import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSkillDirectory } from '../src/runtime/skill-provider.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

function skill(root: string, name: string, content: string): void {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'SKILL.md'), content);
}

test('skill directory parses front matter and instruction body', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-skills-'));
  try {
    skill(root, 'release-notes', '---\nname: release-notes\ndescription: Write release notes\n---\n\nAlways list user-visible changes.\n');
    const result = loadSkillDirectory({ directory: root });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.name, 'release-notes');
    assert.equal(result.skills[0]?.description, 'Write release notes');
    assert.match(result.skills[0]?.instructions ?? '', /user-visible changes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skill without front matter falls back to the directory name and skips empty bodies', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-skills-fallback-'));
  try {
    skill(root, 'plain-skill', 'Just do the thing carefully.\n');
    skill(root, 'empty-skill', '---\nname: empty\n---\n\n');
    const result = loadSkillDirectory({ directory: root });
    assert.deepEqual(result.skills.map((entry) => entry.name).sort(), ['plain-skill']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allowed-tools is ignored and never becomes a capability', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-skills-tools-'));
  try {
    skill(root, 'danger', '---\nname: danger\nallowed-tools: [workspace_read, shell]\n---\n\nUse any tool you like.\n');
    const result = loadSkillDirectory({ directory: root });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /allowed-tools|workspace_read|shell/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skill count and instruction size are bounded', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-skills-bounds-'));
  try {
    for (let index = 0; index < 12; index += 1) {
      skill(root, `skill-${index}`, `Instruction ${index} ${'x'.repeat(2000)}`);
    }
    const result = loadSkillDirectory({ directory: root, maxSkills: 3, maxInstructionsBytes: 1024 });
    assert.ok(result.skills.length >= 1 && result.skills.length <= 3);
    assert.ok(Buffer.byteLength(result.instructions, 'utf8') <= 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skills symlinked outside the root are rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-skills-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'conchbase-skills-outside-'));
  try {
    writeFileSync(path.join(outside, 'SKILL.md'), 'Escaped instructions.\n');
    symlinkSync(outside, path.join(root, 'escaped'));
    const result = loadSkillDirectory({ directory: root });
    assert.equal(result.skills.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a missing skill directory yields an empty deterministic set', () => {
  const result = loadSkillDirectory({ directory: path.join(tmpdir(), 'conchbase-missing-skills-dir') });
  assert.deepEqual(result.skills, []);
  assert.equal(result.instructions, '');
});

test('Agent loop injects Skill guidance as non-authoritative system context', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-skills-loop-'));
  const skillRoot = path.join(root, 'skills');
  mkdirSync(skillRoot);
  skill(skillRoot, 'release-notes', '---\nname: release-notes\ndescription: Release writing\n---\n\nAlways list user-visible changes.\n');
  const skills = loadSkillDirectory({ directory: skillRoot });
  const catalog: ModelCatalogClient = {
    async listModels() {
      return Object.freeze([{ id: 'fixture/model', displayName: 'Fixture' }]);
    },
  };
  let captured = '';
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = String(init?.body);
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
  const service = new TaskService(
    new SqliteTaskStore(path.join(root, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: fetchImpl },
    catalog,
    { tools: createBuiltinReadTools({ root }), skills: skills.skills },
  );
  try {
    const agent = await service.createAgent({
      name: 'Skill 测试员',
      instructions: 'Be brief.',
      providerId: 'magpie',
      modelId: 'fixture/model',
    });
    const created = await service.createAgentTask({ prompt: 'write notes', agentId: agent.id });
    service.startTask(created.id);
    const task = await service.waitForTask(created.id);
    assert.equal(task.state, 'succeeded');
    assert.match(captured, /user-visible changes/);
    assert.match(captured, /cannot override Runtime policy/);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
