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

/**
 * The kernel is the bottom of the dependency graph.
 *
 * It answers "may this run?", so if it imported the runtime it would depend on
 * the thing it governs — and the policy rule could quietly start reading task
 * state. This guard keeps the direction one-way: http → runtime → kernel.
 */
test('the policy kernel depends on nothing above it', () => {
  for (const file of listTypeScriptFiles('src/kernel')) {
    const source = read(file);
    assert.doesNotMatch(source, /from '\.\.\/runtime\//, `${file} must not import the runtime`);
    assert.doesNotMatch(source, /from '\.\.\/http\//, `${file} must not import http`);
    assert.doesNotMatch(source, /from 'node:sqlite'/, `${file} must not touch the database`);
    assert.doesNotMatch(source, /readFileSync|writeFileSync|readdirSync/, `${file} must stay free of file IO`);
  }
  // And the config layer no longer reaches up into the runtime.
  assert.doesNotMatch(read('src/config/runtime-config.ts'), /from '\.\.\/runtime\//);
});

/**
 * Scope and approval must not split again.
 *
 * The rule "a grant can only narrow" used to live in `capability-grants.ts`
 * while approval lived in the kernel. That split is what let `unbounded` waive
 * a list the other module believed was unconditional. This guard fails if a
 * runtime module starts re-deciding scope on its own.
 */
test('scope narrowing stays in the kernel', () => {
  for (const file of listTypeScriptFiles('src/runtime')) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /grant\.kind === 'tool'\)\.map\(\(grant\) => grant\.name\)|new Set\(grants\s*\.filter/,
      `${file} re-implements grant narrowing instead of calling scopeToolSet`,
    );
  }
  assert.match(read('src/runtime/capability-grants.ts'), /scopeToolSet\(/);
});

/**
 * A module nothing imports is not a module, it is a liability.
 *
 * The previous cleanup deleted ~1650 lines of an abandoned execution path that
 * still had twenty passing tests. Nothing failed, because nothing referenced
 * it — which is exactly why a test was needed: dead code does not announce
 * itself, it just makes the system look more complete than it is.
 */
test('every runtime module is imported by something', () => {
  // The CLI is executed directly (`node dist/cli.js`), so it is legitimately
  // imported by nothing. It must also be the *only* entry point: two wiring
  // roots drift, and this repository had already done so.
  const entryPoints = new Set(['src/cli.ts']);
  // Files reachable from an entry point, computed over actual import edges.
  const sources = [...listTypeScriptFiles('src'), ...listTypeScriptFiles('tests')];
  const imported = new Set<string>();
  for (const file of sources) {
    for (const match of read(file).matchAll(/from\s+'([^']+)'/g)) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), match[1]!.replace(/\.js$/, '.ts')),
      );
      imported.add(target);
    }
  }
  // Everything must be reachable from an entry point, directly or through a
  // test. A file only tests import is still load-bearing for coverage.
  const unreferenced = listTypeScriptFiles('src')
    .filter((file) => !entryPoints.has(file) && !imported.has(file));
  assert.deepEqual(unreferenced, [], `modules no source or test imports:\n${unreferenced.join('\n')}`);
  assert.ok([...entryPoints].every((entry) => sources.includes(entry)), 'entry points exist');
  assert.equal(
    [...entryPoints].length,
    1,
    'exactly one process entry point may exist; a second one silently forks startup wiring',
  );
});

test('HTTP tools and web extraction do not import each other', () => {
  const httpTools = read('src/runtime/http-tools.ts');
  const webExtract = read('src/runtime/web-extract.ts');
  assert.doesNotMatch(webExtract, /from '\.\/http-tools\.js'/, 'web extraction must depend on the shared boundary, not the tool wrapper');
  // The wrapper still composes web_extract; the reverse edge is the cycle.
  assert.match(httpTools, /from '\.\/web-extract\.js'/);
});

test('every script is wired to a command or a document', () => {
  const packageJson = read('package.json');
  const documentation = listTypeScriptFiles('docs').length > 0
    ? listTypeScriptFiles('docs').map(read).join('\n')
    : '';
  const readme = read('README.md');
  for (const script of readdirSync(path.join(repositoryRoot, 'scripts')).filter((name) => name.endsWith('.mjs'))) {
    const named = packageJson.includes(script)
      || documentation.includes(script)
      || readme.includes(script)
      || readdirSync(path.join(repositoryRoot, 'scripts')).some((other) =>
        other !== script && read(`scripts/${other}`).includes(script));
    assert.ok(named, `scripts/${script} is not referenced by any command, doc, or other script`);
  }
});

test('capability probes can target any published model', () => {
  const agentProbe = read('scripts/probe-agent-chat.mjs');
  const capabilityProbe = read('scripts/probe-capabilities.mjs');
  assert.match(agentProbe, /--model/);
  assert.match(agentProbe, /modelId,/);
  assert.match(capabilityProbe, /flag\('model'/);
  assert.match(capabilityProbe, /'--model', model/);
  assert.match(agentProbe, /--auto-approve/);
  assert.equal(agentProbe.match(/last\?\.state === 'waiting_approval'/g)?.length, 1);
});

test('user-facing copy says Boss Agent', () => {
  for (const file of [
    'src/runtime/agent-chat.ts',
    'src/runtime/organization-intent-parser.ts',
    'src/runtime/primary-conversation.ts',
    'src/runtime/memory-review.ts',
    'src/cli.ts',
    /*
     * The console is the Pagurus tree now; the hand-written client these paths
     * named was replaced in `codex/dsh-frontend-base`, so a guard that still
     * reads them fails on a checkout that is otherwise correct.
     */
    'pagurus/packages/client/ui-boss-command/src/client/BossCommandPanel.tsx',
    'pagurus/packages/client/ui-boss-command/src/client/locales.ts',
  ]) {
    assert.doesNotMatch(read(file), /老板 Agent|老板回执/, `${file} still uses legacy Boss name`);
  }
  assert.match(read('src/runtime/agent-chat.ts'), /BOSS_AGENT_ID = 'boss-agent'/);
});

test('the runtime has no fixed PM hierarchy', () => {
  for (const file of [
    'src/runtime/organization-intent-parser.ts',
    'src/runtime/boss-mode-service.ts',
    'src/runtime/organization-coordinator.ts',
  ]) {
    assert.doesNotMatch(read(file), /must (?:create|hire|use) (?:a )?(?:PM|project manager)/i,
      `${file} must not require a fixed PM role`);
    assert.doesNotMatch(read(file), /(?:requires?|assumes?|expects?) (?:a )?(?:PM|project manager)/i,
      `${file} must not assume a fixed PM role`);
  }
});

/**
 * Digest shapes must not fork again.
 *
 * Eleven modules had each grown their own `digest`, identical by coincidence.
 * A change to one — another hash, a different truncation — would have produced
 * digests that silently stopped matching their siblings, and digest equality is
 * how several features decide "same thing" or "already applied".
 */
test('digest construction lives in one module', () => {
  const offenders: string[] = [];
  for (const file of listTypeScriptFiles('src')) {
    if (file === 'src/runtime/digest.ts') continue;
    const source = read(file);
    // Only the two shapes `digest.ts` owns are duplication. A bare hex digest
    // and a digest *validator* are different things and stay where they are.
    const reimplementsSha256Prefix = /`sha256:\$\{createHash\('sha256'\)\.update\(value\)\.digest\('hex'\)\}`/.test(source);
    const reimplementsPrefixed = /`\$\{prefix\}_\$\{createHash\('sha256'\)\.update\(value\)\.digest\('hex'\)\.slice\(0, 24\)\}`/.test(source);
    if (reimplementsSha256Prefix || reimplementsPrefixed) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `define digests via src/runtime/digest.ts:\n${offenders.join('\n')}`);
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

test('obsolete process documents stay gone', async () => {
  const { existsSync } = await import('node:fs');
  for (const gone of [
    'docs/AI_HANDOFF.md',
    'docs/PROJECT_STATUS.json',
    'docs/OBJECTIVE_MODE.zh-CN.md',
    'docs/ROADMAP.md',
    'docs/AI_TASK_QUEUE.md',
  ]) {
    assert.equal(existsSync(path.join(repositoryRoot, gone)), false, `${gone} should stay removed`);
  }
  // The entry documents stay short; the plan may be long, the orientation may not.
  for (const short of ['docs/START_HERE.md', 'docs/CURRENT_STATE.md', 'docs/DEVELOPMENT.md']) {
    const lines = readFileSync(path.join(repositoryRoot, short), 'utf8').split('\n').length;
    assert.ok(lines <= 120, `${short} is ${lines} lines; keep entry docs short`);
  }
});

/**
 * A test file that no command runs is documentation, not a check.
 *
 * `npm test` enumerates files by hand and `test-suites.mjs` groups them by
 * layer. Both lists can silently drift when a test is added: the suite script
 * already refuses unassigned files, but nothing caught a file that never made
 * it into `npm test`. This closes that loop so CI cannot claim coverage it
 * does not have.
 */
test('every test file runs in CI and belongs to a suite', () => {
  const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const inCi = new Set([...manifest.scripts.test!.matchAll(/tests\/([\w.-]+\.test\.ts)/g)].map((match) => match[1]!));
  const present = readdirSync(path.join(repositoryRoot, 'tests'))
    .filter((name) => name.endsWith('.test.ts'));

  assert.deepEqual(present.filter((name) => !inCi.has(name)), [], 'test files missing from `npm test`');
  assert.deepEqual([...inCi].filter((name) => !present.includes(name)), [], '`npm test` names a missing file');

  const suites = read('scripts/test-suites.mjs');
  for (const file of present) {
    assert.ok(suites.includes(`'${file}'`), `${file} is not referenced by scripts/test-suites.mjs`);
  }
});
