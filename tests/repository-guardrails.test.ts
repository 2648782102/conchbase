import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const forbiddenPackages = ['better-sqlite3', 'sqlite3', 'openai', '@anthropic-ai/sdk'];
const forbiddenImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](better-sqlite3|sqlite3|openai|@anthropic-ai\/sdk)['"]/;
const privateFileIo = /\b(?:readFileSync|readFile|writeFileSync|writeFile|appendFile|createReadStream|createWriteStream)\b/;
const nonLoopbackAddress = /0\.0\.0\.0|::\/0/;
const loopbackHosts = /const LOOPBACK_HOSTS = new Set\(\['127\.0\.0\.1', '::1', 'localhost'\]\)/;

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function listTypeScriptFiles(relativeDir: string): string[] {
  const absoluteDir = path.join(repositoryRoot, relativeDir);
  return readdirSync(absoluteDir, { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(relativeDir, entry.name).replaceAll(path.sep, '/');
      if (entry.isDirectory()) return listTypeScriptFiles(child);
      return entry.isFile() && child.endsWith('.ts') ? [child] : [];
    })
    .sort();
}

test('development entry points describe the personal Agent product', () => {
  assert.match(read('AGENTS.md'), /docs\/START_HERE\.md/);
  assert.match(read('docs/START_HERE.md'), /personal Agent runtime/);
  assert.match(read('docs/START_HERE.md'), /PROJECT_PLAN\.md/);
  assert.match(read('docs/CURRENT_STATE.md'), /Important limitations/);
  assert.match(read('docs/PROJECT_PLAN.md'), /Phase 0/);
  assert.match(read('docs/PROJECT_PLAN.md'), /P0\.1/);
  assert.match(read('docs/PROJECT_PLAN.md'), /P1\.1/);
  assert.match(read('docs/PROJECT_PLAN.md'), /P3\.7/);
  assert.match(read('docs/DEVELOPMENT.md'), /failing focused test/);
  assert.match(read('docs/PAIRED_DEVELOPMENT.md'), /Runtime port/);
  assert.match(read('docs/PAIRED_DEVELOPMENT.md'), /Common failures/);
  assert.match(read('docs/VALIDATION_PLAN.md'), /secret-like values absent/);

  for (const file of [
    'docs/START_HERE.md',
    'docs/CURRENT_STATE.md',
    'docs/PROJECT_PLAN.md',
    'docs/DEVELOPMENT.md',
    'docs/ARCHITECTURE.md',
    'docs/API.md',
    'docs/TECH_STACK.md',
    'docs/VALIDATION_PLAN.md',
    'docs/openapi.yaml',
  ]) {
    assert.doesNotThrow(() => read(file), `${file} must be part of the current documentation set`);
  }
});

test('public API and local binding remain explicit', () => {
  const openApi = read('docs/openapi.yaml');
  assert.match(openApi, /^  version: 1\.1\.0$/m);
  assert.match(openApi, /provider-neutral-model-catalog/);
  assert.match(openApi, /AgentRevision/);
  assert.match(openApi, /partialOutput/);
  assert.match(openApi, /No tool is executed/);
  assert.match(openApi, /write-only-secret-handles/);
  assert.doesNotMatch(openApi, nonLoopbackAddress);

  const config = read('src/config/runtime-config.ts');
  assert.match(config, loopbackHosts);
  assert.doesNotMatch(config, nonLoopbackAddress);
});

test('runtime boundaries do not leak private IO or unapproved SDKs', () => {
  for (const file of [...listTypeScriptFiles('src'), ...listTypeScriptFiles('tests')]) {
    assert.doesNotMatch(read(file), forbiddenImport, `${file} imports an unapproved SDK`);
  }
  for (const file of listTypeScriptFiles('src/http')) {
    if (file === 'src/http/routes/v1/platform.ts' || file === 'src/http/routes/v1/runtime.ts') continue;
    assert.doesNotMatch(read(file), privateFileIo, `${file} reads private files directly`);
  }
  assert.match(read('src/runtime/task-store.ts'), /from 'node:sqlite'/);
  assert.match(read('src/runtime/task-store.ts'), /PRAGMA locking_mode = EXCLUSIVE/);
  assert.match(read('src/runtime/task-service.ts'), /composition-execution/);
  assert.match(read('src/runtime/task-service.ts'), /tool-request/);
  assert.doesNotMatch(read('src/runtime/tool-request.ts'), /ToolCapabilityKernel|tool\.executed/);
  assert.doesNotMatch(read('src/runtime/task-service.ts'), /plaintextSecret|resolveSecret|decryptSecret/);
});

test('dependency baseline stays consistent', () => {
  const manifest = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const lock = JSON.parse(read('package-lock.json')) as { packages?: Record<string, unknown> };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ['@modelcontextprotocol/sdk', 'fastify']);
  for (const name of forbiddenPackages) {
    assert.equal(name in (manifest.dependencies ?? {}), false);
    assert.equal(name in (manifest.devDependencies ?? {}), false);
    assert.equal(Object.keys(lock.packages ?? {}).some((key) => key.endsWith(`/node_modules/${name}`)), false);
  }
});
