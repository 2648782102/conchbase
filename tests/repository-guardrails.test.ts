import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface PackageLock {
  readonly packages?: Record<string, unknown>;
}

const forbiddenPackages: readonly string[] = [
  'better-sqlite3',
  'sqlite3',
  '@types/better-sqlite3',
  'openai',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
];

const forbiddenImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](better-sqlite3|sqlite3|openai|@anthropic-ai\/sdk|@modelcontextprotocol\/sdk)['"]/;
const importPrefix = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]/;
const forbiddenRuntimeImport = new RegExp(
  `${importPrefix.source}(?:fastify|node:https?|[^'"]*\\/http\\/)[^'"]*['"]`,
);
const privateFileIo = /\b(?:readFileSync|readFile|writeFileSync|writeFile|appendFile|createReadStream|createWriteStream)\b/;
const loopbackHosts = /const LOOPBACK_HOSTS = new Set\(\['127\.0\.0\.1', '::1', 'localhost'\]\)/;
const nonLoopbackAddress = /0\.0\.0\.0|::\/0/;
const acceptedPaths = [
  '/v1/health',
  '/v1/runtime',
  '/v1/models',
  '/v1/tasks',
  '/v1/tasks/{taskId}',
  '/v1/tasks/{taskId}/cancel',
  '/v1/tasks/{taskId}/retry',
  '/v1/events',
];

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function listTypeScriptFiles(relativeDir: string): string[] {
  const absoluteDir = path.join(repositoryRoot, relativeDir);
  return readdirSync(absoluteDir, { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(child);
      return entry.isFile() && child.endsWith('.ts') ? [child] : [];
    })
    .sort();
}

function assertNoForbiddenImportIn(source: string, label: string): void {
  assert.doesNotMatch(
    source,
    forbiddenImport,
    `${label} must not import an unaccepted provider or storage SDK`,
  );
}

function assertAcceptedOpenApi(spec: string, label: string): void {
  assert.deepEqual(
    [...spec.matchAll(/^ {2}(\/v1\/[^:]+):$/gm)].map((match) => match[1]),
    acceptedPaths,
    `${label} must expose the accepted phase-1 paths`,
  );
  assert.deepEqual(
    [...spec.matchAll(/^ {2}- url: (.+)$/gm)].map((match) => match[1]),
    ['http://127.0.0.1:4318'],
    `${label} must keep a single loopback server URL`,
  );
  assert.doesNotMatch(spec, nonLoopbackAddress, `${label} must not bind beyond loopback`);
  assert.match(spec, /requestBody:/, `${label} must document the accepted task request`);
  assert.match(spec, /interrupted/, `${label} must document interrupted tasks`);
}

function assertLoopbackConfig(source: string, label: string): void {
  assert.match(source, loopbackHosts, `${label} must keep exactly the documented loopback hosts`);
  assert.doesNotMatch(source, nonLoopbackAddress, `${label} must reject non-loopback hosts`);
}

function assertHttpBoundary(source: string, label: string): void {
  assert.doesNotMatch(
    source,
    privateFileIo,
    `${label} must not read or write private runtime files`,
  );
}

function assertRuntimeBoundary(source: string, label: string): void {
  assert.doesNotMatch(
    source,
    forbiddenRuntimeImport,
    `${label} must stay independent of Fastify and HTTP transport`,
  );
}

function assertDependencyBoundaries(
  manifest: PackageManifest,
  lock: PackageLock,
  label: string,
): void {
  const packages = lock.packages;
  assert.ok(packages, `${label} must contain a packages map`);
  const lockNames = Object.keys(packages);

  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ['fastify'],
    `${label} runtime dependencies must remain the accepted baseline`,
  );
  for (const name of forbiddenPackages) {
    assert.equal(
      Object.keys(manifest.dependencies ?? {}).includes(name),
      false,
      `${label} must not declare ${name} as a runtime dependency`,
    );
    assert.equal(
      Object.keys(manifest.devDependencies ?? {}).includes(name),
      false,
      `${label} must not declare ${name} as a development dependency`,
    );
    assert.equal(
      lockNames.some((key) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)),
      false,
      `${label} must not contain ${name} in package-lock.json`,
    );
  }
}

test('AI-first entry documents describe the implemented real-model slice', () => {
  const agents = read('AGENTS.md');
  for (const phrase of [
    'built primarily by AI coding agents',
    'Read `docs/AI_HANDOFF.md` first',
    'Conchbase is the agent execution authority.',
    'Never execute a tool outside the runtime policy and approval path.',
    'A Skill supplies instructions; it does not grant tool permissions.',
    'Keep loopback-only binding until authentication and pairing are designed and implemented.',
    "Do not let a UI read or write Conchbase's private files or database.",
    'Run `npm run check`, `npm test`, and `npm run build` after code changes.',
    'Keep `tests/repository-guardrails.test.ts` passing; update it only alongside an accepted ADR or a documented development-boundary change.',
  ]) {
    assert.ok(agents.includes(phrase), `AGENTS.md must keep: ${phrase}`);
  }

  const handoff = read('docs/AI_HANDOFF.md');
  assert.match(handoff, /Phase 1 connects a real model through Magpie/);
  assert.match(handoff, /interrupted/);
  assert.match(handoff, /explicit retry/);
  assert.match(handoff, /does not implement user-defined agent composition/);

  const queue = read('docs/AI_TASK_QUEUE.md');
  assert.match(queue, /single-turn/);
  assert.match(queue, /topology-neutral/);

  assert.match(read('README.md'), /real model/);
  assert.match(read('README.md'), /planned work/);
  assert.match(read('README.zh-CN.md'), /真实模型/);
  assert.match(read('README.zh-CN.md'), /仍在规划中/);
});

test('decision records separate accepted phase-1 direction from proposals', () => {
  const decisionsDir = 'docs/decisions';
  const files = readdirSync(path.join(repositoryRoot, decisionsDir))
    .filter((file) => file.endsWith('.md'))
    .sort();
  const proposals = files.filter((file) => /^000[2-8]-/.test(file));

  assert.equal(proposals.length, 7, 'ADRs 0002-0008 must remain proposal records');
  for (const file of proposals) {
    assert.match(
      read(`${decisionsDir}/${file}`),
      /^Status: \*\*proposed, not accepted as a public contract\*\*$/m,
      `${file} must remain a proposal`,
    );
  }

  assert.match(
    read(`${decisionsDir}/0010-first-real-model-slice.md`),
    /^Status: \*\*accepted product and internal architecture direction/m,
  );
  assert.match(
    read(`${decisionsDir}/0009-ai-development-guardrails.md`),
    /^Status: accepted for repository development guardrails, not a public API contract\.$/m,
  );
});

test('the public contract remains loopback-only and records accepted task routes', () => {
  assertAcceptedOpenApi(read('docs/openapi.yaml'), 'docs/openapi.yaml');
  assertLoopbackConfig(read('src/config/runtime-config.ts'), 'src/config/runtime-config.ts');
});

test('accepted source boundaries reject unaccepted adapters and private-file access', () => {
  const sourceFiles = listTypeScriptFiles('src');
  const testFiles = listTypeScriptFiles('tests');
  assert.ok(sourceFiles.length > 0);
  assert.ok(testFiles.length > 0);

  for (const file of [...sourceFiles, ...testFiles]) {
    assertNoForbiddenImportIn(read(file), file);
  }

  for (const file of listTypeScriptFiles('src/http')) {
    assertHttpBoundary(read(file), file);
  }

  for (const file of listTypeScriptFiles('src/runtime')) {
    assertRuntimeBoundary(read(file), file);
  }

  assert.match(
    read('src/runtime/task-store.ts'),
    /from 'node:sqlite'/,
    'the accepted phase-1 persistence driver must be the built-in module',
  );
});

test('dependencies do not silently accept provider or storage SDKs', () => {
  const manifest = JSON.parse(read('package.json')) as PackageManifest;
  const lock = JSON.parse(read('package-lock.json')) as PackageLock;
  assertDependencyBoundaries(manifest, lock, 'package manifests');
});

test('guardrail helpers reject representative boundary violations', () => {
  const syntheticForbiddenImport = ['from ', "'openai'"].join('');
  const syntheticRuntimeImport = ['import Fastify ', "from 'fastify';"].join('');
  const syntheticPrivateRead = ['const content = ', 'readFileSync', "('secret');"].join('');
  const syntheticNonLoopbackConfig = [
    'const LOOPBACK_HOSTS = new Set([',
    "'0.0.0.0'",
    ']);',
  ].join('');
  const syntheticMissingPath = [
    'paths:',
    '  /v1/health:',
    '    post:',
  ].join('\n');

  assert.throws(
    () => assertNoForbiddenImportIn(syntheticForbiddenImport, 'synthetic'),
    /must not import an unaccepted provider/,
  );
  assert.throws(
    () => assertAcceptedOpenApi(syntheticMissingPath, 'synthetic'),
    /must expose the accepted phase-1 paths/,
  );
  assert.throws(
    () => assertLoopbackConfig(syntheticNonLoopbackConfig, 'synthetic'),
    /must keep exactly the documented loopback hosts/,
  );
  assert.throws(
    () => assertHttpBoundary(syntheticPrivateRead, 'synthetic'),
    /must not read or write private runtime files/,
  );
  assert.throws(
    () => assertRuntimeBoundary(syntheticRuntimeImport, 'synthetic'),
    /must stay independent of Fastify/,
  );

  const badDevManifest: PackageManifest = {
    dependencies: { fastify: '^5.12.8' },
    devDependencies: { 'better-sqlite3': '13.0.3' },
  };
  const badLock: PackageLock = {
    packages: { '': {}, 'node_modules/sqlite3': {} },
  };
  assert.throws(
    () => assertDependencyBoundaries(badDevManifest, { packages: {} }, 'synthetic'),
    /must not declare better-sqlite3 as a development dependency/,
  );
  assert.throws(
    () => assertDependencyBoundaries({ dependencies: { fastify: '^5.12.8' } }, badLock, 'synthetic'),
    /must not contain sqlite3 in package-lock.json/,
  );
});
