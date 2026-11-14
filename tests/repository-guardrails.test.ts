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

interface ProjectStatus {
  readonly schemaVersion: number;
  readonly repository: string;
  readonly release: string;
  readonly objectiveMode: string;
  readonly developmentBoundaryAdr: string;
  readonly publicContract: {
    readonly version: string;
    readonly pathCount: number;
    readonly frozen: boolean;
    readonly additive?: {
      readonly version: string;
      readonly pathCount: number;
      readonly frozen: boolean;
    };
    readonly execution?: {
      readonly version: string;
      readonly pathCount: number;
      readonly frozen: boolean;
    };
    readonly executionRun?: {
      readonly version: string;
      readonly pathCount: number;
      readonly frozen: boolean;
    };
    readonly conversation?: {
      readonly version: string;
      readonly pathCount: number;
      readonly frozen: boolean;
    };
    readonly agentChat?: {
      readonly version: string;
      readonly pathCount: number;
      readonly frozen: boolean;
    };
  };
  readonly aiEntry: {
    readonly requiredOrder: readonly string[];
  };
  readonly implemented: readonly { readonly id: string }[];
  readonly validationEvidence: readonly { readonly id: string; readonly executableFixture?: boolean }[];
  readonly blockedDirections: readonly {
    readonly id: string;
    readonly requiresAcceptedAdr: boolean;
  }[];
  readonly nextBoundedSlices: readonly {
    readonly id: string;
    readonly publicContractChange: boolean;
    readonly requiresAcceptedAdr: boolean;
    readonly status: 'ready' | 'proposal';
    readonly requiredAdr?: string;
  }[];
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
  '/v1/model-catalog',
  '/v1/agents',
  '/v1/agents/{agentId}',
  '/v1/agents/{agentId}/duplicate',
  '/v1/agents/{agentId}/archive',
  '/v1/agents/{agentId}/revisions',
  '/v1/agents/{agentId}/revisions/apply',
  '/v1/agents/default',
  '/v1/tasks',
  '/v1/tasks/{taskId}',
  '/v1/tasks/{taskId}/cancel',
  '/v1/tasks/{taskId}/retry',
  '/v1/events',
  '/v1/configuration',
  '/v1/configuration/revisions',
  '/v1/configuration/revisions/{revisionId}',
  '/v1/configuration/validate',
  '/v1/configuration/apply',
  '/v1/tool-requests',
  '/v1/tool-requests/{requestId}',
  '/v1/tool-requests/{requestId}/approval',
  '/v1/provider-observations/tool-calls',
  '/v1/work/triggers',
  '/v1/work/items',
  '/v1/work/items/{workItemId}',
  '/v1/work/delivery-receipts',
  '/v1/work/delivery-receipts/{receiptId}/decision',
  '/v1/work/assignments/{assignmentId}/reconcile',
  '/v1/work/items/{workItemId}/start',
  '/v1/work/items/{workItemId}/stop',
  '/v1/work/items/{workItemId}/complete',
  '/v1/work/events',
  '/v1/auth/pairings',
  '/v1/auth/pairings/approve',
  '/v1/auth/pairings/{pairingId}/revoke',
  '/v1/auth/tokens',
  '/v1/auth/tokens/{tokenId}/revoke',
  '/v1/sources/local/events',
  '/v1/capabilities',
  '/v1/secret-handles',
  '/v1/secret-handles/{handleId}/rotate',
  '/v1/secret-handles/{handleId}/status',
  '/v1/secret-handles/{handleId}/use',
  '/v1/secret-handles/use-receipts',
  '/v1/organization/session',
  '/v1/organization/session/intents',
  '/v1/organization/projects',
  '/v1/organization/projects/{projectId}',
  '/v1/organization/projects/{projectId}/threads',
  '/v1/organization/agents/proposals',
  '/v1/organization/agents/proposals/{proposalId}',
  '/v1/organization/delegations',
  '/v1/organization/delegations/{delegationId}',
  '/v1/organization/work-items',
  '/v1/organization/work-items/{workItemId}',
  '/v1/organization/reports',
  '/v1/organization/reports/{reportId}',
  '/v1/organization/attention',
  '/v1/organization/attention/{attentionId}',
  '/v1/organization/attention/{attentionId}/answer',
  '/v1/organization/attention/{attentionId}/withdraw',
  '/v1/organization/events',
  '/v1/organization/conversation',
  '/v1/organization/conversation/messages',
  '/v1/agent-chat/agents',
  '/v1/agent-chat/conversations',
  '/v1/agent-chat/conversations/{conversationId}',
  '/v1/agent-chat/conversations/{conversationId}/messages',
  '/v1/execution/health',
  '/v1/execution/capabilities',
  '/v1/execution/grants',
  '/v1/execution/grants/{grantId}/revoke',
  '/v1/execution/requests',
  '/v1/execution/requests/{requestId}',
  '/v1/execution/requests/{requestId}/decide',
  '/v1/execution/events',
  '/v1/execution/run-health',
  '/v1/execution/adapters',
  '/v1/execution/runs',
  '/v1/execution/runs/{runId}',
  '/v1/execution/runs/{runId}/start',
  '/v1/execution/runs/{runId}/cancel',
  '/v1/execution/runs/{runId}/recover',
  '/v1/execution/runs/{runId}/events',
];
const frozenPathCount = 47;
const organizationPathCount = 18;
const executionPathCount = 8;
const executionRunPathCount = 8;
const conversationPathCount = 2;
const agentChatPathCount = 4;

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
    `${label} must expose the accepted additive 1.0.0 and 1.1.0 paths`,
  );
  assert.deepEqual(
    [...spec.matchAll(/^ {2}- url: (.+)$/gm)].map((match) => match[1]),
    ['http://127.0.0.1:4318'],
    `${label} must keep a single loopback server URL`,
  );
  assert.doesNotMatch(spec, nonLoopbackAddress, `${label} must not bind beyond loopback`);
  assert.match(spec, /requestBody:/, `${label} must document the accepted task request`);
  assert.match(spec, /interrupted/, `${label} must document interrupted tasks`);
  assert.match(spec, /^  version: 1\.0\.0$/m, `${label} must record the durable-work contract version`);
  assert.match(spec, /provider-neutral-model-catalog/);
  assert.match(spec, /AgentRevision/);
  assert.match(spec, /partialOutput/, `${label} must document partial output`);
  assert.match(spec, /ConfigurationRevision/, `${label} must document configuration revisions`);
  assert.match(spec, /tool-approval-ledger/);
  assert.match(spec, /write-only-secret-handles/);
  assert.match(spec, /write-only-secret-handles/);
  assert.match(spec, /authenticated-pairing/);
  assert.match(spec, /asynchronous-work-control/);
  assert.match(spec, /local-source-policy/);
  assert.match(spec, /capability-directory/);
  assert.match(spec, /write-only-secret-handles/);
  assert.match(spec, /provider-tool-call-observation records/);
  assert.match(spec, /durable-work-contract/);
  assert.match(spec, /WorkEnvelope/);
  assert.match(spec, /No tool is executed/);
  assert.match(spec, /- tool\.requested/);
  assert.doesNotMatch(spec, /- tool\.executed/);
  assert.match(spec, /Public tool ledger events carry toolRequestId/);
  assert.match(spec, /provider-tool-call-observation records/);
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

function assertProjectStatus(source: string, label: string): void {
  const status = JSON.parse(source) as ProjectStatus;
  assert.equal(status.schemaVersion, 1, `${label} must use status schema version 1`);
  assert.equal(status.repository, 'conchbase', `${label} must identify the runtime repository`);
  assert.equal(status.release, '1.0.0', `${label} must record the current release`);
  assert.equal(status.objectiveMode, 'target-mode', `${label} must record target mode`);
  assert.equal(status.developmentBoundaryAdr, '0026-ai-handoff-readiness-development-boundary.md');
  assert.equal(status.publicContract.version, '1.0.0');
  assert.equal(status.publicContract.pathCount, 47);
  assert.equal(status.publicContract.frozen, true);
  assert.deepEqual(status.publicContract.additive, {
    version: '1.1.0',
    pathCount: organizationPathCount,
    frozen: true,
  });
  assert.deepEqual(status.publicContract.execution, {
    version: '1.2.0',
    pathCount: executionPathCount,
    frozen: true,
  });
  assert.deepEqual(status.publicContract.executionRun, {
    version: '1.3.0',
    pathCount: executionRunPathCount,
    frozen: true,
  });
  assert.deepEqual(status.publicContract.conversation, {
    version: '1.4.0',
    pathCount: conversationPathCount,
    frozen: true,
  });
  assert.deepEqual(status.publicContract.agentChat, {
    version: '1.6.0',
    pathCount: agentChatPathCount,
    frozen: true,
  });
  assert.deepEqual(status.aiEntry.requiredOrder, [
    'AGENTS.md',
    'docs/AI_HANDOFF.md',
    'docs/PROJECT_STATUS.json',
    'docs/OBJECTIVE_MODE.zh-CN.md',
    'docs/AI_DEVELOPMENT.md',
    'docs/AI_TASK_QUEUE.md',
  ], `${label} must record the canonical AI reading order`);
  assert.ok(status.implemented.some((record) => record.id === 'local-first-v1-platform'));
  assert.equal(
    status.validationEvidence.some((record) => record.id === 'local-first-e2e-walkthrough' && !record.executableFixture),
    true,
    `${label} must keep the completed walkthrough as non-executable validation evidence`,
  );
  assert.equal(
    status.validationEvidence.some(
      (record) => record.id === 'provider-conformance-fixture' && record.executableFixture === true,
    ),
    true,
    `${label} must record the executable provider-compatibility fixture`,
  );
  assert.equal(
    status.validationEvidence.some(
      (record) => record.id === 'persistence-conformance-fixture' && record.executableFixture === true,
    ),
    true,
    `${label} must record the executable persistence fixture`,
  );
  assert.ok(status.blockedDirections.length >= 5, `${label} must record ADR-gated directions`);
  for (const direction of status.blockedDirections) {
    assert.equal(direction.requiresAcceptedAdr, true, `${direction.id} must require an accepted ADR`);
  }
  for (const slice of status.nextBoundedSlices) {
    if (slice.status === 'ready') {
      assert.equal(slice.publicContractChange, false, `${slice.id} must not change the public contract`);
      assert.equal(slice.requiresAcceptedAdr, false, `${slice.id} must be executable without a new ADR`);
      assert.equal(slice.requiredAdr, undefined, `${slice.id} must not name a required ADR`);
    } else {
      // A proposal may change the public contract only through its own accepted ADR.
      assert.equal(slice.requiresAcceptedAdr, true, `${slice.id} must require its accepted ADR`);
      assert.ok(slice.requiredAdr, `${slice.id} must name its required ADR`);
    }
  }
}

function assertSequentialHandoffReadOrder(source: string, label: string): void {
  const section = source.split('## Read in this order')[1]?.split('\n## ')[0];
  assert.ok(section, `${label} must contain a numbered reading order`);
  const numbers = [...section.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
  assert.deepEqual(
    numbers,
    numbers.map((_value, index) => index + 1),
    `${label} must number its reading order sequentially without duplicates`,
  );
}

function assertStaticVisualOverview(source: string, label: string): void {
  assert.match(source, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${label} must be a standalone SVG`);
  const sourceWithoutNamespace = source.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
  assert.match(source, /role="img"/, `${label} must expose an accessible image role`);
  assert.match(source, /aria-labelledby="title desc"/, `${label} must include accessible text`);
  assert.doesNotMatch(source, /<script\b/i, `${label} must not contain scripts`);
  assert.doesNotMatch(source, /<foreignObject\b/i, `${label} must not contain HTML fragments`);
  assert.doesNotMatch(sourceWithoutNamespace, /https?:\/\//i, `${label} must not make external references`);
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket/i, `${label} must not call external services`);
  assert.doesNotMatch(source, /PROJECT_STATUS\.json|OBJECTIVE_MODE\.zh-CN\.md|aiEntry\.requiredOrder/, `${label} must not enter the AI reading packet`);
  const visibleText = [...source.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((match) => match[1])
    .join('\n');
  assert.doesNotMatch(visibleText, /\d/, `${label} must not hardcode numeric status claims in visible text`);
  assert.doesNotMatch(visibleText, /\b(?:113|80|112|79)\b/, `${label} must not hardcode validation counts`);
  assert.match(source, /非契约事实源|not a contract source of truth/, `${label} must label itself as non-authoritative`);
}

test('AI-first entry documents describe the implemented real-model slice', () => {
  const agents = read('AGENTS.md');
  for (const phrase of [
    'built primarily by AI coding agents',
    'Read `docs/AI_HANDOFF.md` first',
    'Conchbase is the agent execution authority.',
    'Never execute a tool outside the runtime policy and approval path.',
    'A Skill supplies instructions; it does not grant tool permissions.',
    'Default loopback-only binding remains; non-loopback binding requires explicit approved pairing/authentication.',
    "Do not let a UI read or write Conchbase's private files or database.",
    'Run `npm run check`, `npm test`, and `npm run build` after code changes.',
    'Keep `tests/repository-guardrails.test.ts` passing; update it only alongside an accepted ADR or a documented development-boundary change.',
    'Read `docs/PROJECT_STATUS.json` before selecting a task; `blockedDirections` are not implemented behavior and require an accepted ADR.',
  ]) {
    assert.ok(agents.includes(phrase), `AGENTS.md must keep: ${phrase}`);
  }

  const handoff = read('docs/AI_HANDOFF.md');
  assert.match(handoff, /Phase 1 currently connects a real model through the Magpie compatibility adapter/);
  assert.match(handoff, /interrupted/);
  assert.match(handoff, /explicit retry/);
  assert.match(handoff, /The broader user-defined composition product remains open/);
  assert.match(handoff, /exact OpenAPI path set is forty-seven paths/);
  assert.match(handoff, /ADR 0025/);
  assert.match(handoff, /ADR 0020/);
  assert.match(handoff, /ADR 0021/);
  assert.match(handoff, /ADR 0022/);
  assert.match(handoff, /ADR 0023/);
  assert.match(handoff, /ADRs `0030`–`0056`/);
  assert.match(handoff, /ORGANIZATION_RUNTIME_TARGET\.zh-CN\.md/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /organization-contract\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /organization-store\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /organization-store\.sqlite\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /organization-execution\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /organization-agent-projection\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /organization-coordinator\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /boss-mode-service\.ts/);
  assert.match(read('tests/organization-contract.test.ts'), /organization kernel/);
  assert.match(read('tests/organization-store.test.ts'), /organization store/);
  assert.match(read('tests/organization-persistence.test.ts'), /organization actions migrate/);
  assert.match(read('tests/organization-execution.test.ts'), /organization execution planner/);
  assert.match(read('tests/organization-agent-projection.test.ts'), /dynamic agent projection/);
  assert.match(read('tests/organization-coordinator.test.ts'), /coordinator applies one action/);
  assert.match(read('tests/boss-mode-service.test.ts'), /boss mode creates a real Agent revision/);
  assert.match(read('tests/organization-e2e.test.ts'), /dual-repository Boss-mode product loop/);
  assert.match(read('docs/decisions/0041-boss-mode-product-loop.md'), /accepted and implemented final Boss-mode product loop/);
  assert.match(handoff, /Plaintext handle values are never returned/);
  assert.match(handoff, /process-scoped AES-256-GCM sealed value/);
  assert.match(handoff, /deterministic live loopback paired-runtime acceptance/);

  const queue = read('docs/AI_TASK_QUEUE.md');
  assert.match(queue, /single-turn/);
  assert.match(queue, /topology-neutral/);
  assert.match(queue, /ADR 0015/);
  assert.match(queue, /ADR 0016/);
  assert.match(queue, /ADR 0017/);
  assert.match(queue, /ADR 0018/);
  assert.match(queue, /ADR 0019/);
  assert.match(queue, /Streaming tool-call accumulation/);
  assert.match(queue, /Done in the provider tool-call parsing boundary slice/);
  assert.match(queue, /Done in the explicit provider observation slice/);
  assert.match(queue, /product direction is a user-managed collection of independently customizable Agents/);
  assert.match(queue, /first collection\/editor and task-binding slice/);
  assert.match(queue, /Magpie.*not the product's sole provider or future Agent model contract/);
  assert.match(queue, /Future Agent model references and discovery must be provider-neutral/);
  assert.match(queue, /at least two Agents/);
  assert.match(queue, /transactional additive schema migration/);
  assert.match(queue, /Check legacy `\/v1\/tasks`/);
  assert.match(queue, /Streaming tool-call accumulation and execution/);
  assert.match(queue, /short-lived private database ownership/);
  assert.match(queue, /Interface validation/);
  assert.match(queue, /Pagurus ADR 0007/);
  assert.match(queue, /History contract, if needed/);
  assert.match(queue, /ADR 0021/);
  assert.match(queue, /ADR 0022/);
  assert.match(queue, /ADR 0023/);
  assert.match(queue, /ADR 0024/);
  assert.match(queue, /ADR 0024.*implements the first deterministic/s);
  assert.match(queue, /SecretHandle boundary/);
  assert.match(queue, /Done in the deterministic paired-runtime acceptance slice/);
  assert.match(queue, /ADRs `0010`–`0025`/);
  assert.match(queue, /final local-first `1\.0\.0` target is closed/);

  const roadmap = read('docs/ROADMAP.md');
  assert.match(roadmap, /current adapter uses Magpie for compatibility/);
  assert.match(roadmap, /Agent definitions and Runtime API contracts must not depend on Magpie catalog ids/);
  assert.match(roadmap, /deterministic fake adapters/);

  const readme = read('README.md');
  assert.match(readme, /Magpie is the supported compatibility path today/);
  assert.match(readme, /not the product's only intended provider/);
  assert.match(readme, /Future provider-neutral Agent references/);
  assert.match(
    read('docs/decisions/0010-first-real-model-slice.md'),
    /does not make Magpie the product goal, the only supported future provider, or the schema for Agent model references/,
  );
  assert.match(
    read('docs/decisions/0012-streaming-output-progress.md'),
    /Magpie observations below justify the current compatibility implementation only/,
  );

  assert.match(read('README.md'), /real model/);
  assert.match(read('README.md'), /remain outside the final local-first target/);
  assert.match(read('README.md'), /ADR 0018/);
  assert.match(read('README.md'), /ADR 0019/);
  assert.match(read('README.zh-CN.md'), /真实模型/);
  assert.match(read('README.zh-CN.md'), /仍在最终本地优先目标之外/);
  assert.match(read('README.zh-CN.md'), /ADR 0018/);
  assert.match(read('README.zh-CN.md'), /ADR 0019/);
  assert.match(read('README.md'), /accepted ADRs \[0010–0056\]/);
  assert.match(read('README.md'), /1\.4\.0/);
  assert.match(read('README.md'), /ADR 0021 adds an opt-in live loopback acceptance test/);
  assert.match(read('README.zh-CN.md'), /ADR 0021/);
  assert.match(read('README.zh-CN.md'), /真实 loopback HTTP 验收/);
  assert.match(read('README.md'), /quick start/);
  assert.match(read('README.md'), /v1\.0\.0 release notes/);
  assert.match(read('README.zh-CN.md'), /快速开始/);
  assert.match(read('README.zh-CN.md'), /v1\.0\.0 发布说明/);
  assert.match(read('docs/AI_HANDOFF.md'), /Chinese release and quick-start documents/);
  assert.match(read('docs/QUICK_START.zh-CN.md'), /AI-first 开发顺序/);
  assert.match(read('docs/QUICK_START.zh-CN.md'), /契约事实源/);
  assert.match(read('docs/RELEASE_NOTES_1.0.0.zh-CN.md'), /中文发布说明/);
  assert.match(read('docs/RELEASE_NOTES_1.0.0.zh-CN.md'), /本 Release 同时附带上述中文文档资产/);
  assert.match(read('docs/RELEASE_NOTES_1.1.0.zh-CN.md'), /Boss Mode `1\.1\.0`/);
  assert.match(read('docs/QUICK_START.zh-CN.md'), /conchbase boss/);
  assert.match(read('docs/decisions/0042-controlled-execution-direction.md'), /accepted product direction; implementation blocked/);
  assert.match(read('docs/decisions/0043-controlled-execution-v1.md'), /accepted and implemented v1 fake-executor boundary/);
  assert.match(read('docs/decisions/0044-isolated-local-execution-v2.md'), /accepted and implemented isolated local execution v2/);
  assert.match(read('docs/decisions/0045-primary-conversation-projection.md'), /accepted and implemented primary conversation projection/);
  assert.match(read('docs/decisions/0046-agent-chat-module.md'), /accepted and implemented agent chat module/);
  assert.match(read('docs/decisions/0047-boss-agent-adapter.md'), /accepted and implemented boss agent adapter/);
  assert.match(read('docs/decisions/0048-agent-chat-conversation-states.md'), /accepted and implemented Agent Chat conversation state model/);
  assert.match(read('docs/decisions/0049-boss-conversation.md'), /accepted and implemented Boss Agent natural conversation boundary/);
  assert.match(read('docs/decisions/0051-agent-chat-model-selection.md'), /modelOverride/);
  assert.match(read('docs/decisions/0050-boss-conversation-hardening.md'), /accepted and implemented Boss conversation hardening boundary/);
  assert.match(read('tests/agent-chat.test.ts'), /natural model reply for ordinary conversation/);
  assert.match(read('tests/primary-conversation.test.ts'), /primary conversation projects/);
  assert.match(read('tests/agent-chat.test.ts'), /publishes a real model reply/);
  assert.match(read('tests/agent-chat.test.ts'), /boss agent appears in Agent Chat/);
  assert.match(read('docs/RELEASE_NOTES_1.4.0.zh-CN.md'), /主会话对话投影/);
  assert.match(read('docs/RELEASE_NOTES_1.5.0.zh-CN.md'), /独立 Agent 对话/);
  const validationPlan = read('docs/VALIDATION_PLAN.md');
  assert.match(validationPlan, /ADR 0021's opt-in paired-runtime acceptance/);
  assert.match(validationPlan, /Live real-provider conformance, real-browser accessibility validation/);
  const decision0021 = read('docs/decisions/0021-cross-repository-paired-runtime-acceptance.md');
  assert.match(
    decision0021,
    /^Status: \*\*accepted development-boundary change; no public API contract changes\*\*$/m,
  );
  assert.match(decision0021, /`TaskService\.stop\(\)` is an asynchronous shutdown boundary/);
  assert.match(decision0021, /no public API contract changes/);
  assert.match(decision0021, /The exact `0\.8\.0` 25-route OpenAPI contract/);
  const decision0022 = read('docs/decisions/0022-persistent-work-runtime-direction.md');
  assert.match(
    decision0022,
    /^Status: \*\*accepted product and architecture direction; no public API contract changes\*\*$/m,
  );
  assert.match(decision0022, /WorkItem/);
  assert.match(decision0022, /DeliveryReceipt/);
  assert.match(decision0022, /no public API contract changes/);
  const decision0023 = read('docs/decisions/0023-secret-handle-and-runtime-injection-proposal.md');
  assert.match(
    decision0023,
    /^Status: \*\*proposed, not accepted as a public contract\*\*$/m,
  );
  assert.match(decision0023, /SecretHandle/);
  assert.match(decision0023, /An Agent revision may contain bounded handle references/);
  assert.match(decision0023, /Rejected because arbitrary tool execution plus a resolver is an exfiltration primitive/);
  const referenceProjects = read('docs/REFERENCE_PROJECTS.md');
  assert.match(referenceProjects, /Super-agent research cross-check/);
  assert.match(referenceProjects, /Session is an implementation detail/);
  const taskService = read('src/runtime/task-service.ts');
  assert.match(taskService, /private stopping = false;/);
  assert.match(taskService, /async stop\(\): Promise<void>/);
  assert.match(taskService, /this\.stopping = true;/);
  assert.match(taskService, /if \(this\.stopping\) return;/);
  assert.match(taskService, /await Promise\.allSettled\(\[\.\.\.this\.inFlight\]\)/);
  assert.match(read('src/http/routes/v1/tasks.ts'), /statusCode === 400/);
  assert.match(read('tests/task-api.test.ts'), /emptyJsonBody\.statusCode, 400/);
  assert.match(read('package.json'), /tests\/agent-paired-runtime\.test\.ts/);
  assert.match(read('package.json'), /tests\/provider-conformance\.test\.ts/);
  assert.match(read('package.json'), /tests\/persistence-conformance\.test\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /tests\/provider-conformance\.test\.ts/);
  assert.match(read('docs/AI_DEVELOPMENT.md'), /tests\/persistence-conformance\.test\.ts/);
  assert.match(read('docs/AI_HANDOFF.md'), /decisions\/archive\//);
  const pairedTest = read('tests/agent-paired-runtime.test.ts');
  assert.match(pairedTest, /nested Pagurus checkout is not present/);
  assert.match(pairedTest, /delayedPrompts\.delete\(delayKey\)/);
  assert.match(pairedTest, /execFileAsync/);
  assert.match(read('docs/decisions/0024-durable-work-domain-and-public-api.md'), /accepted public contract and first deterministic persistence slice/);
});

test('decision records separate accepted phase-1 direction from proposals', () => {
  const decisionsDir = 'docs/decisions';
  const files = readdirSync(path.join(repositoryRoot, decisionsDir))
    .filter((file) => file.endsWith('.md'))
    .sort();
  const proposals = files.filter((file) => /^000[2-8]-/.test(file));

  assert.equal(proposals.length, 0, 'superseded proposals must live in docs/decisions/archive/');
  for (const file of [
    '0002-task-lifecycle-proposal.md',
    '0003-event-ordering-proposal.md',
    '0004-configuration-revision-proposal.md',
    '0005-user-defined-agent-topology-proposal.md',
    '0006-provider-adapter-capability-boundary-proposal.md',
    '0007-skill-plugin-mcp-configuration-proposal.md',
    '0008-sqlite-driver-compatibility-proposal.md',
  ]) {
    assert.match(
      read(`${decisionsDir}/archive/${file}`),
      /^Status: \*\*proposed, not accepted as a public contract\*\*$/m,
      `${file} must remain an archived proposal`,
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
  assert.match(
    read(`${decisionsDir}/0011-phase-one-database-instance-ownership.md`),
    /^Status: \*\*accepted internal persistence boundary; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0011-phase-one-database-instance-ownership.md`),
    /single-owner development boundary/,
  );
  assert.match(
    read(`${decisionsDir}/0012-streaming-output-progress.md`),
    /^Status: \*\*accepted product and public API direction/m,
  );
  assert.match(
    read(`${decisionsDir}/0014-versioned-configuration-api.md`),
    /^Status: \*\*accepted product and public API direction/m,
  );
  assert.match(
    read(`${decisionsDir}/0013-bounded-tool-capability-kernel.md`),
    /^Status: \*\*accepted internal architecture boundary; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0015-composition-identity-kernel.md`),
    /^Status: \*\*accepted internal architecture direction; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/archive/0005-user-defined-agent-topology-proposal.md`),
    /ADR 0015.*internal, topology-neutral identity kernel/s,
  );
  assert.match(
    read(`${decisionsDir}/0016-composition-execution-and-public-schema.md`),
    /^Status: \*\*accepted product and public API direction/m,
  );
  assert.match(
    read(`${decisionsDir}/archive/0005-user-defined-agent-topology-proposal.md`),
    /ADR 0016.*bounded public graph representation/s,
  );
  assert.match(
    read(`${decisionsDir}/0017-public-tool-request-approval-ledger.md`),
    /^Status: \*\*accepted product and public API direction/m,
  );
  assert.match(
    read(`${decisionsDir}/0018-provider-tool-call-parsing-boundary.md`),
    /^Status: \*\*accepted internal architecture direction; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0019-explicit-provider-tool-call-observation-boundary.md`),
    /^Status: \*\*accepted product and public API direction; contracts are versioned in `docs\/openapi\.yaml`\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0020-multi-agent-and-provider-neutral-model-contract.md`),
    /^Status: \*\*accepted product and public API direction; contracts are versioned in `docs\/openapi\.yaml`\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0022-persistent-work-runtime-direction.md`),
    /^Status: \*\*accepted product and architecture direction; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0023-secret-handle-and-runtime-injection-proposal.md`),
    /^Status: \*\*proposed, not accepted as a public contract\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0024-durable-work-domain-and-public-api.md`),
    /^Status: \*\*accepted public contract and first deterministic persistence slice\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0025-local-first-v1-platform.md`),
    /^Status: \*\*accepted final local-first public contract and implementation boundary\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0025-local-first-v1-platform.md`),
    /process-scoped AES-256-GCM key/,
  );
  assert.match(
    read(`${decisionsDir}/0026-ai-handoff-readiness-development-boundary.md`),
    /^Status: \*\*accepted repository development boundary; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0026-ai-handoff-readiness-development-boundary.md`),
    /does not change `docs\/openapi\.yaml`/,
  );
  assert.match(
    read(`${decisionsDir}/0027-optional-visual-overview.md`),
    /^Status: \*\*accepted repository documentation boundary; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0028-interface-validation-boundary.md`),
    /^Status: \*\*accepted repository development boundary; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0028-interface-validation-boundary.md`),
    /tests\/provider-conformance\.test\.ts/,
  );
  assert.match(
    read(`${decisionsDir}/0028-interface-validation-boundary.md`),
    /\.\.\/\.\.\/pagurus\/docs\/decisions\/0014-interface-validation-boundary\.md/,
  );
  assert.match(
    read(`${decisionsDir}/0029-persistence-test-boundary.md`),
    /^Status: \*\*accepted repository development boundary; no public API contract changes\*\*$/m,
  );
  assert.match(
    read(`${decisionsDir}/0029-persistence-test-boundary.md`),
    /tests\/persistence-conformance\.test\.ts/,
  );
});

test('target-mode status and Chinese objective brief are machine-checkable entry artifacts', () => {
  assertProjectStatus(read('docs/PROJECT_STATUS.json'), 'docs/PROJECT_STATUS.json');
  const currentStatus = JSON.parse(read('docs/PROJECT_STATUS.json')) as ProjectStatus;
  assert.ok(currentStatus.implemented.some((record) => record.id === 'agent-loop-v1'));
  assert.ok(currentStatus.validationEvidence.some(
    (record) => record.id === 'agent-loop-fixture' && record.executableFixture === true,
  ));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'organization-domain-kernel'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'organization-store'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'organization-persistence'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'organization-execution-planner'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'dynamic-agent-projection'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'organization-coordinator'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'organization-public-api'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'boss-mode-execution-bridge'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'boss-mode-real-model-adapter'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'dynamic-agent-revisions'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'concurrent-project-work'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'structured-reporting'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'archive-offboard-resume'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'organization-runtime'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'bounded-delegation'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'controlled-execution-v1'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'isolated-execution-v2'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'primary-conversation-projection'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'agent-chat-module'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'boss-agent-adapter'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'agent-chat-conversation-states'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'boss-natural-conversation'));
  assert.ok(currentStatus.implemented.some((record) => record.id === 'boss-conversation-hardening'));
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-domain-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-store-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-persistence-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-execution-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'dynamic-agent-projection-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-coordinator-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-api-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'boss-mode-execution-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-intent-parser-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'boss-mode-http-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'organization-product-loop-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'controlled-execution-v1-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'isolated-execution-v2-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'primary-conversation-projection-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'agent-chat-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'boss-agent-adapter-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'agent-chat-conversation-states-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'boss-natural-conversation-fixture' && record.executableFixture === true,
    ),
  );
  assert.ok(
    currentStatus.validationEvidence.some(
      (record) => record.id === 'boss-conversation-hardening-fixture' && record.executableFixture === true,
    ),
  );
  assert.match(read('docs/OBJECTIVE_MODE.zh-CN.md'), /完整组织运行时/);
  assert.match(read('docs/OBJECTIVE_MODE.zh-CN.md'), /0041/);
  assert.match(read('docs/OBJECTIVE_MODE.zh-CN.md'), /ORGANIZATION_RUNTIME_TARGET\.zh-CN\.md/);
  assert.match(read('docs/AI_TASK_QUEUE.md'), /ORGANIZATION_RUNTIME_TARGET\.zh-CN\.md/);
  assertSequentialHandoffReadOrder(read('docs/AI_HANDOFF.md'), 'docs/AI_HANDOFF.md');

  const objective = read('docs/OBJECTIVE_MODE.zh-CN.md');
  assert.match(objective, /最终目标状态/);
  assert.match(objective, /立刻能做什么/);
  assert.match(objective, /必须先立 ADR 才能做什么/);
  assert.match(objective, /辩证取舍/);
  assert.match(objective, /PROJECT_STATUS\.json/);
  assert.match(objective, /ADR 0026/);
  assert.match(objective, /不变量/);

  for (const file of [
    'AGENTS.md',
    'README.md',
    'README.zh-CN.md',
    'docs/AI_HANDOFF.md',
    'docs/AI_DEVELOPMENT.md',
    'docs/AI_TASK_QUEUE.md',
    'docs/QUICK_START.zh-CN.md',
  ]) {
    assert.match(read(file), /PROJECT_STATUS\.json/, `${file} must link the machine-readable status`);
    assert.match(read(file), /OBJECTIVE_MODE\.zh-CN\.md/, `${file} must link the Chinese objective brief`);
  }
  assert.match(read('docs/AI_TASK_QUEUE.md'), /Target-mode entry/);
  assert.match(read('README.md'), /accepted ADRs \[0010–0056\]/);
  assert.match(read('README.md'), /Organization Runtime target/);
  assert.match(read('README.zh-CN.md'), /完整组织运行时目标/);
  assert.match(read('docs/QUICK_START.zh-CN.md'), /ADR 0030–0034/);
  assert.match(read('docs/decisions/0026-ai-handoff-readiness-development-boundary.md'), /validationEvidence/);
  assert.match(read('docs/decisions/0026-ai-handoff-readiness-development-boundary.md'), /blockedDirections/);
  assert.match(read('docs/AI_TASK_QUEUE.md'), /ADR 0028 and Pagurus ADR 0014/);
  assert.match(read('docs/AI_TASK_QUEUE.md'), /ADR 0029/);
  assert.match(read('docs/OBJECTIVE_MODE.zh-CN.md'), /ADR 0029/);
  assert.match(read('README.zh-CN.md'), /ADR 0029/);
  assert.match(read('docs/QUICK_START.zh-CN.md'), /ADR 0029/);
  assert.match(read('docs/VALIDATION_PLAN.md'), /tests\/persistence-conformance\.test\.ts/);
  assert.match(read('docs/AI_HANDOFF.md'), /tests\/persistence-conformance\.test\.ts/);
  assert.match(read('docs/OBJECTIVE_MODE.zh-CN.md'), /ADR 0028/);
  assert.match(read('README.zh-CN.md'), /ADR 0028/);
  assert.match(read('docs/QUICK_START.zh-CN.md'), /ADR 0028/);
  assert.match(read('docs/VALIDATION_PLAN.md'), /tests\/provider-conformance\.test\.ts/);
  assert.match(read('docs/AI_HANDOFF.md'), /tests\/provider-conformance\.test\.ts/);
  for (const file of [
    'docs/AI_HANDOFF.md',
    'docs/OBJECTIVE_MODE.zh-CN.md',
    'docs/QUICK_START.zh-CN.md',
    'README.md',
    'README.zh-CN.md',
  ]) {
    assert.match(read(file), /aiEntry\.requiredOrder/, `${file} must name the canonical AI reading order`);
  }
  assert.match(
    read('docs/decisions/0026-ai-handoff-readiness-development-boundary.md'),
    /aiEntry\.requiredOrder/,
  );
  assertStaticVisualOverview(
    read('docs/assets/conchbase-status-doodle.svg'),
    'docs/assets/conchbase-status-doodle.svg',
  );
  const visualOverview = read('docs/VISUAL_OVERVIEW.zh-CN.md');
  assert.match(visualOverview, /不是契约事实源/);
  assert.match(visualOverview, /不参与 guardrail 校验/);
  assert.doesNotMatch(visualOverview, /aiEntry\.requiredOrder/);
  assert.match(read('README.md'), /optional \[visual overview\]\(docs\/VISUAL_OVERVIEW\.zh-CN\.md\)/);
  assert.match(read('README.md'), /not a contract source of truth/);
  assert.match(read('README.zh-CN.md'), /可选的\[视觉概览\]\(docs\/VISUAL_OVERVIEW\.zh-CN\.md\)/);
  assert.match(read('README.zh-CN.md'), /不是契约事实源/);
  for (const file of [
    'docs/AI_HANDOFF.md',
    'docs/AI_DEVELOPMENT.md',
    'docs/AI_TASK_QUEUE.md',
    'docs/OBJECTIVE_MODE.zh-CN.md',
    'docs/QUICK_START.zh-CN.md',
    'docs/RELEASE_NOTES_1.0.0.zh-CN.md',
  ]) {
    assert.doesNotMatch(read(file), /VISUAL_OVERVIEW|conchbase-status-doodle\.svg/, `${file} must keep the visual out of the AI reading packet`);
  }
  assert.doesNotMatch(
    read('docs/RELEASE_NOTES_1.0.0.zh-CN.md'),
    /OBJECTIVE_MODE\.zh-CN\.md|PROJECT_STATUS\.json|ADR 0026/,
    'the v1.0.0 release notes must remain an immutable publication snapshot',
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

  for (const file of listTypeScriptFiles('src/http').filter(
    (candidate) => candidate !== 'src/http/routes/v1/platform.ts'
      && candidate !== 'src/http/routes/v1/runtime.ts',
  )) {
    assertHttpBoundary(read(file), file);
  }

  for (const file of listTypeScriptFiles('src/runtime').filter(
    (candidate) => !candidate.startsWith('src/runtime/platform-'),
  )) {
    assertRuntimeBoundary(read(file), file);
  }

  assert.match(
    read('src/runtime/task-store.ts'),
    /from 'node:sqlite'/,
    'the accepted phase-1 persistence driver must be the built-in module',
  );
  assert.match(
    read('src/runtime/task-store.ts'),
    /PRAGMA locking_mode = EXCLUSIVE/,
    'the accepted phase-1 database must reject a second owner',
  );
  assert.match(
    read('src/cli.ts'),
    /new MagpieModelCatalog\(/,
    'model catalog commands must not need the runtime database',
  );
  assert.match(
    read('src/http/routes/v1/runtime.ts'),
    /composition-execution/,
    'the runtime status must advertise composition execution',
  );
  assert.match(
    read('src/http/routes/v1/runtime.ts'),
    /tool-approval-ledger/,
    'the runtime status must advertise the tool approval ledger',
  );
  assert.match(
    read('src/http/routes/v1/runtime.ts'),
    /provider-tool-call-observation/,
    'the runtime status must advertise transient provider observations',
  );
  assert.match(read('src/http/routes/v1/runtime.ts'), /provider-neutral-model-catalog/);
  assert.match(read('src/http/routes/v1/runtime.ts'), /agents/);
  assert.match(read('src/http/routes/v1/runtime.ts'), /durable-work-contract/);
  assert.match(read('src/http/routes/v1/runtime.ts'), /authenticated-pairing/);
  assert.match(read('src/http/routes/v1/runtime.ts'), /asynchronous-work-control/);
  assert.match(read('src/http/routes/v1/runtime.ts'), /local-source-policy/);
  assert.match(read('src/http/routes/v1/runtime.ts'), /capability-directory/);
  assert.match(read('src/http/routes/v1/runtime.ts'), /write-only-secret-handles/);
  assert.match(read('src/runtime/task-store.ts'), /BEGIN EXCLUSIVE/);
  assert.match(read('src/runtime/task-store.ts'), /migrateAgentSchema/);
  assert.match(
    read('src/runtime/tool-capability.ts'),
    /export class ToolCapabilityKernel/,
    'the bounded internal tool kernel must remain explicit',
  );
  assert.doesNotMatch(
    read('src/runtime/tool-capability.ts'),
    forbiddenRuntimeImport,
    'the internal tool kernel must not import HTTP transport',
  );
  assert.doesNotMatch(
    read('src/runtime/task-service.ts'),
    /tool-capability/,
    'the phase-1 HTTP task path must not execute model-requested tools',
  );
  assert.match(
    read('src/runtime/task-service.ts'),
    /composition-execution/,
    'the runtime task service must dispatch accepted composition execution',
  );
  assert.match(
    read('src/runtime/task-service.ts'),
    /tool-request/,
    'the public ledger must use the separate tool request boundary',
  );
  const workRouteSource = read('src/http/routes/v1/work.ts');
  assert.doesNotMatch(workRouteSource, /fetch\(|exec|spawn|writeFile|readFile/i);
  assert.doesNotMatch(workRouteSource, /Router|Worker|three-layer|layered|hierarchy/i);
  assert.match(read('src/runtime/task-store.ts'), /PRAGMA user_version = 6/);
  const ledgerSource = read('src/runtime/tool-request.ts');
  assert.doesNotMatch(ledgerSource, /ToolCapabilityKernel|tool-capability/);
  assert.doesNotMatch(ledgerSource, /tool\.executed|tool\.replayed|tool\.denied|tool\.failed/);
  assert.doesNotMatch(ledgerSource, /composition-document/);
  const ledgerRoutes = read('src/http/routes/v1/tool-requests.ts');
  assert.doesNotMatch(ledgerRoutes, /tool-capability|ToolCapabilityKernel/);
  assert.doesNotMatch(ledgerRoutes, /execute|executor|tool\.executed/i);
  const parserSource = read('src/runtime/provider-tool-call.ts');
  assert.match(parserSource, /export function parseOpenAiChatCompletionsToolCall/);
  assert.doesNotMatch(parserSource, /tool-capability|ToolCapabilityKernel|task-service|task-store|fastify/);
  assert.doesNotMatch(parserSource, /tool\.executed|tool\.replayed|tool\.denied|tool\.failed|tool\.requested/);
  assert.doesNotMatch(parserSource, /taskId|compositionNodeId|configurationRevisionId|approval|decision/);
  const providerSource = read('src/runtime/magpie-provider.ts');
  assert.match(providerSource, /provider-tool-call/, 'the provider must own ADR 0018 normalization');
  assert.doesNotMatch(providerSource, /tool-capability|ToolCapabilityKernel|task-service|task-store/);
  const observationRoute = read('src/http/routes/v1/provider-observations.ts');
  assert.match(observationRoute, /provider-tool-call/, 'the observation route must use the pure parser');
  assert.doesNotMatch(observationRoute, /tool-capability|ToolCapabilityKernel|task-service|task-store|createToolRequest|execute|executor|tool\.executed/i);
  assert.match(observationRoute, /parseOpenAiChatCompletionsToolCall/);
  assert.doesNotMatch(observationRoute, /SqliteTaskStore|readFileSync|writeFileSync/);
  for (const file of [
    'src/runtime/task-service.ts',
    'src/runtime/task-store.ts',
    'src/runtime/tool-capability.ts',
    'src/runtime/tool-request.ts',
    ...listTypeScriptFiles('src/http').filter((candidate) =>
      candidate.replaceAll('\\', '/') !== 'src/http/routes/v1/provider-observations.ts'
      && candidate.replaceAll('\\', '/') !== 'src/http/routes/v1/runtime.ts',
    ),
  ]) {
    assert.doesNotMatch(
      read(file),
      /provider-tool-call|parseOpenAiChatCompletionsToolCall/,
      `${file} must not wire the ADR 0019 parser boundary outside the provider and observation route`,
    );
  }
  assert.doesNotMatch(
    read('src/runtime/task-service.ts'),
    /tool_call_observation[\s\S]{0,400}createToolRequest|createToolRequest[\s\S]{0,400}tool_call_observation/,
    'the live task path must not auto-create ledger requests from provider observations',
  );
  const compositionSource = read('src/runtime/composition-document.ts');
  assert.match(
    compositionSource,
    /export function parseCompositionDocument/,
    'the internal composition identity kernel must remain explicit',
  );
  assert.doesNotMatch(compositionSource, forbiddenRuntimeImport);
  assert.doesNotMatch(compositionSource, /tool-capability|ToolCapabilityKernel/);
  assert.doesNotMatch(compositionSource, /planner|researcher|reviewer|orchestrator|three[- ]layer|layer[_-]?[123]/i);
  assert.doesNotMatch(
    read('src/runtime/task-service.ts'),
    /composition-document/,
    'the task service must use the dedicated composition execution boundary',
  );
  assert.match(
    read('src/runtime/configuration-document.ts'),
    /composition-document/,
    'the public versioned configuration validator must own composition validation',
  );
  assert.match(
    read('src/runtime/composition-execution.ts'),
    /composition-document/,
    'the dedicated composition executor must own graph identity',
  );
  for (const file of listTypeScriptFiles('src/http').filter(
    (candidate) => candidate !== 'src/http/routes/v1/platform.ts'
      && candidate !== 'src/http/routes/v1/runtime.ts',
  )) {
    assert.doesNotMatch(
      read(file),
      /tool-capability/,
      `${file} must not expose the internal tool kernel`,
    );
    assert.doesNotMatch(
      read(file),
      /secret-handle|SecretHandle|resolveSecret|getValue|plaintext/i,
      `${file} must not expose an unaccepted SecretHandle resolver`,
    );
    assert.doesNotMatch(
      read(file),
      /composition-document/,
      `${file} must not expose the internal composition kernel`,
    );
  }
  for (const file of listTypeScriptFiles('src/runtime').filter(
    (candidate) => !candidate.startsWith('src/runtime/platform-'),
  )) {
    assert.doesNotMatch(
      read(file),
      /SecretHandle|resolveSecret|decryptSecret|plaintextSecret/i,
      `${file} must not implement an unaccepted secret resolver`,
    );
  }
  for (const file of listTypeScriptFiles('src/runtime').filter(
    (candidate) => candidate !== 'src/runtime/configuration-document.ts'
      && candidate !== 'src/runtime/composition-document.ts'
      && candidate !== 'src/runtime/composition-execution.ts',
  )) {
    assert.doesNotMatch(
      read(file),
      /composition-document/,
      `${file} must not import the internal composition identity kernel directly`,
    );
  }
  const executionSource = read('src/runtime/composition-execution.ts');
  assert.doesNotMatch(executionSource, forbiddenRuntimeImport);
  assert.doesNotMatch(executionSource, /tool-capability|ToolCapabilityKernel/);
  assert.doesNotMatch(executionSource, /planner|researcher|reviewer|orchestrator|three[- ]layer|layer[_-]?[123]/i);
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
  const baseStatus = {
    schemaVersion: 1,
    repository: 'conchbase',
    release: '1.0.0',
    objectiveMode: 'target-mode',
    developmentBoundaryAdr: '0026-ai-handoff-readiness-development-boundary.md',
    publicContract: {
      version: '1.0.0',
      pathCount: frozenPathCount,
      frozen: true,
      additive: { version: '1.1.0', pathCount: organizationPathCount, frozen: true },
      execution: { version: '1.2.0', pathCount: executionPathCount, frozen: true },
      executionRun: { version: '1.3.0', pathCount: executionRunPathCount, frozen: true },
      conversation: { version: '1.4.0', pathCount: conversationPathCount, frozen: true },
      agentChat: { version: '1.6.0', pathCount: agentChatPathCount, frozen: true },
    },
    aiEntry: {
      requiredOrder: [
        'AGENTS.md',
        'docs/AI_HANDOFF.md',
        'docs/PROJECT_STATUS.json',
        'docs/OBJECTIVE_MODE.zh-CN.md',
        'docs/AI_DEVELOPMENT.md',
        'docs/AI_TASK_QUEUE.md',
      ],
    },
    implemented: [{ id: 'local-first-v1-platform' }, { id: 'stable-cross-process-secrets' }],
    validationEvidence: [
      { id: 'local-first-e2e-walkthrough', executableFixture: false },
      { id: 'provider-conformance-fixture', executableFixture: true },
      { id: 'persistence-conformance-fixture', executableFixture: true },
    ],
    blockedDirections: [
      { id: 'stable-cross-process-secrets', requiresAcceptedAdr: true },
      { id: 'real-external-sources', requiresAcceptedAdr: true },
      { id: 'executable-tools', requiresAcceptedAdr: true },
      { id: 'production-remote-pairing', requiresAcceptedAdr: true },
      { id: 'generated-clients', requiresAcceptedAdr: true },
    ],
    nextBoundedSlices: [{
      id: 'validation',
      publicContractChange: false,
      requiresAcceptedAdr: false,
      status: 'ready',
    }],
  };
  const statusWithSlice = (slice: Record<string, unknown>) => ({
    ...baseStatus,
    nextBoundedSlices: [slice],
  });
  const invalidReadingOrder = {
    ...baseStatus,
    aiEntry: { requiredOrder: ['AGENTS.md', 'docs/AI_DEVELOPMENT.md'] },
  };
  const invalidBlockedStatus = {
    ...baseStatus,
    blockedDirections: [
      { id: 'stable-cross-process-secrets', requiresAcceptedAdr: false },
      ...baseStatus.blockedDirections.slice(1),
    ],
  };
  const invalidSliceStatus = statusWithSlice({
    id: 'validation',
    publicContractChange: false,
    requiresAcceptedAdr: true,
    status: 'ready',
  });
  const invalidProposalStatus = statusWithSlice({
    id: 'validation',
    publicContractChange: false,
    requiresAcceptedAdr: false,
    status: 'proposal',
    requiredAdr: 'persistence-test-boundary',
  });
  const invalidProposalMissingAdr = statusWithSlice({
    id: 'validation',
    publicContractChange: false,
    requiresAcceptedAdr: true,
    status: 'proposal',
  });
  const invalidReadyWithAdr = statusWithSlice({
    id: 'validation',
    publicContractChange: false,
    requiresAcceptedAdr: false,
    status: 'ready',
    requiredAdr: 'persistence-test-boundary',
  });

  assert.throws(
    () => assertNoForbiddenImportIn(syntheticForbiddenImport, 'synthetic'),
    /must not import an unaccepted provider/,
  );
  assert.throws(
    () => assertAcceptedOpenApi(syntheticMissingPath, 'synthetic'),
    /must expose the accepted additive 1\.0\.0 and 1\.1\.0 paths/,
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
  assert.throws(
    () => assertProjectStatus(JSON.stringify(invalidBlockedStatus), 'synthetic'),
    /stable-cross-process-secrets must require an accepted ADR/,
  );
  assert.throws(
    () => assertProjectStatus(JSON.stringify(invalidReadingOrder), 'synthetic'),
    /must record the canonical AI reading order/,
  );
  assert.throws(
    () => assertProjectStatus(JSON.stringify(invalidSliceStatus), 'synthetic'),
    /validation must be executable without a new ADR/,
  );
  assert.throws(
    () => assertProjectStatus(JSON.stringify(invalidProposalStatus), 'synthetic'),
    /validation must require its accepted ADR/,
  );
  assert.throws(
    () => assertProjectStatus(JSON.stringify(invalidProposalMissingAdr), 'synthetic'),
    /validation must name its required ADR/,
  );
  assert.throws(
    () => assertProjectStatus(JSON.stringify(invalidReadyWithAdr), 'synthetic'),
    /validation must not name a required ADR/,
  );
  assert.throws(
    () => assertSequentialHandoffReadOrder('## Read in this order\n\n1. A\n1. B\n', 'synthetic'),
    /must number its reading order sequentially/,
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
