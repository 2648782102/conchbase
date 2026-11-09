import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/http/create-app.js';
import { createTaskService } from '../src/runtime/task-service.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const pagurusAgentClientPath = path.join(repositoryRoot, 'pagurus/src/shared/api/agents.ts');
const pairedCheckoutAvailable = existsSync(pagurusAgentClientPath);
const execFileAsync = promisify(execFile);

interface AgentRecordFixture {
  readonly id: string;
  readonly currentRevisionId: string;
  readonly archived: boolean;
  readonly isDefault: boolean;
  readonly current: {
    readonly id: string;
    readonly name: string;
    readonly instructions: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly createdAt: string;
  };
}

interface AgentDetailFixture extends AgentRecordFixture {
  readonly revisions: readonly AgentRecordFixture['current'][];
}

interface TaskFixture {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configurationRevisionId: string;
  readonly state: string;
  readonly attempt: number;
  readonly output: string | null;
  readonly partialOutput: string | null;
  readonly error: string | null;
  readonly agentId?: string;
  readonly agentRevisionId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
}

interface ConfigurationDocumentFixture {
  readonly schemaVersion: 1 | 2;
  readonly name: string;
  readonly skills: readonly unknown[];
  readonly policies: readonly unknown[];
  readonly mcpServers: readonly unknown[];
  readonly plugins: readonly unknown[];
  readonly secretRefs: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly composition?: {
    readonly schemaVersion: 1;
    readonly name: string;
    readonly nodes: readonly { readonly id: string; readonly label: string }[];
    readonly links: readonly unknown[];
    readonly entryNodeIds: readonly string[];
    readonly metadata: Readonly<Record<string, string>>;
  };
}

interface ConfigurationApplyResultFixture {
  readonly changed: boolean;
  readonly activeRevisionId: string;
  readonly revision: { readonly id: string };
  readonly revisions: readonly { readonly id: string }[];
}

interface AgentClientModule {
  readonly createAgent: (profile: unknown) => Promise<AgentDetailFixture>;
  readonly updateAgent: (
    agentId: string,
    expectedRevisionId: string,
    profile: unknown,
  ) => Promise<AgentDetailFixture>;
  readonly duplicateAgent: (agentId: string, revisionId?: string) => Promise<AgentDetailFixture>;
  readonly archiveAgent: (agentId: string) => Promise<AgentRecordFixture>;
  readonly applyAgentRevision: (
    agentId: string,
    revisionId: string,
    expectedRevisionId: string,
  ) => Promise<AgentDetailFixture>;
  readonly setDefaultAgent: (agentId: string | null) => Promise<AgentRecordFixture | null>;
  readonly listAgents: () => Promise<readonly AgentRecordFixture[]>;
  readonly getAgent: (agentId: string) => Promise<AgentDetailFixture>;
  readonly getDefaultAgent: () => Promise<AgentRecordFixture | null>;
  readonly listProviderModels: () => Promise<readonly {
    readonly providerId: string;
    readonly modelId: string;
    readonly reference: string;
    readonly displayName: string;
    readonly capabilities: readonly string[];
  }[]>;
  readonly supportsAgentManagement: () => Promise<boolean>;
}

interface TaskClientModule {
  readonly createTask: (input: Record<string, unknown>) => Promise<TaskFixture>;
  readonly getTask: (taskId: string) => Promise<TaskFixture>;
  readonly cancelTask: (taskId: string) => Promise<TaskFixture>;
  readonly retryTask: (taskId: string) => Promise<TaskFixture>;
  readonly listModels: () => Promise<readonly { readonly id: string; readonly displayName: string }[]>;
}

interface ConfigurationClientModule {
  readonly getConfigurationState: () => Promise<{
    readonly revision: { readonly id: string; readonly document: ConfigurationDocumentFixture };
  }>;
  readonly validateConfiguration: (document: unknown) => Promise<ConfigurationDocumentFixture>;
  readonly applyConfiguration: (document: unknown) => Promise<ConfigurationApplyResultFixture>;
  readonly rollbackConfiguration: (revisionId: string) => Promise<ConfigurationApplyResultFixture>;
}

interface RuntimeClientModule {
  readonly getRuntimeInfo: () => Promise<{
    readonly name: string;
    readonly version: string;
    readonly capabilities: readonly string[];
  }>;
}

interface FakeGatewayOptions {
  readonly delayPrompts?: readonly string[];
}

interface FakeGateway {
  readonly origin: string;
  readonly requests: { readonly model: string; readonly prompt: string }[];
  close(): Promise<void>;
}

interface LiveRuntime {
  readonly origin: string;
  readonly databasePath: string;
  readonly service: ReturnType<typeof createTaskService>;
  close(): Promise<void>;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function terminalFrame(output: string): string {
  return `${sseFrame({ choices: [{ delta: { content: output }, finish_reason: 'stop' }] })}data: [DONE]\n\n`;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Loopback test server has no TCP address.');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => cause ? reject(cause) : resolve());
  });
}

async function startFakeGateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const requests: { model: string; prompt: string }[] = [];
  const delayedPrompts = new Set(options.delayPrompts ?? []);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          data: [
            { id: 'fixture/model-a', display_name: 'Fixture A' },
            { id: 'fixture/model-b', display_name: 'Fixture B' },
          ],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(await readRequestBody(request)) as {
          readonly model: string;
          readonly messages: readonly { readonly content: string }[];
        };
        const prompt = body.messages[0]?.content ?? '';
        requests.push({ model: body.model, prompt });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delayKey = prompt.split('\n\n').at(-1) ?? '';
        if (delayedPrompts.delete(delayKey)) {
          response.write(sseFrame({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }));
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        }
        response.end(terminalFrame('answer'));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unknown fake gateway route.' }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end();
    });
  });
  const origin = await listen(server);
  return Object.freeze({
    origin,
    requests,
    async close() {
      server.closeAllConnections();
      await closeServer(server);
    },
  });
}

async function startRuntime(fakeGatewayOrigin: string, databasePath: string): Promise<LiveRuntime> {
  const service = createTaskService(databasePath, {
    magpieBaseUrl: fakeGatewayOrigin,
    defaultModel: 'fixture/model-a',
  });
  const app = createApp({ logger: false, taskService: service });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return Object.freeze({
    origin,
    databasePath,
    service,
    async close() {
      await app.close();
      await service.stop();
    },
  });
}

function pagurusModuleUrl(relativePath: string): string {
  return pathToFileURL(path.join(repositoryRoot, 'pagurus', relativePath)).href;
}

function installFetchShim(runtimeOrigin: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string' && /^https?:\/\//.test(input)) return originalFetch(input, init);
    const requested = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url;
    const target = /^https?:\/\//.test(requested) || !requested.startsWith('/v1/')
      ? requested
      : `${runtimeOrigin}${requested}`;
    return originalFetch(target, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function waitForTerminalTask(
  getTask: (taskId: string) => Promise<TaskFixture>,
  taskId: string,
): Promise<TaskFixture> {
  for (let pollIndex = 0; pollIndex < 200; pollIndex += 1) {
    const task = await getTask(taskId);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state.`);
}

function v2Document(name: string): ConfigurationDocumentFixture {
  return {
    schemaVersion: 2,
    name,
    skills: [],
    policies: [],
    mcpServers: [],
    plugins: [],
    secretRefs: [],
    metadata: {},
    composition: {
      schemaVersion: 1,
      name: 'paired acceptance fixture',
      nodes: [{ id: 'node-a', label: 'First node' }],
      links: [],
      entryNodeIds: ['node-a'],
      metadata: {},
    },
  };
}

test('Pagurus clients and Conchbase close the two-Agent loop over live loopback HTTP', {
  skip: pairedCheckoutAvailable ? false : 'nested Pagurus checkout is not present',
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-paired-runtime-'));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const gateway = await startFakeGateway({
    delayPrompts: ['Cancel this task.', 'Interrupt this task.'],
  });
  let runtime: LiveRuntime | undefined;
  let restoreFetch: (() => void) | undefined;

  try {
    runtime = await startRuntime(gateway.origin, databasePath);
    restoreFetch = installFetchShim(runtime.origin);
    const agentApi = await import(pagurusModuleUrl('src/shared/api/agents.ts')) as AgentClientModule;
    const taskApi = await import(pagurusModuleUrl('src/shared/api/tasks.ts')) as TaskClientModule;
    const configurationApi = await import(
      pagurusModuleUrl('src/shared/api/configuration.ts')
    ) as ConfigurationClientModule;
    const runtimeApi = await import(pagurusModuleUrl('src/shared/api/runtime.ts')) as RuntimeClientModule;

    const status = await runtimeApi.getRuntimeInfo();
    assert.equal(status.version, '0.8.0');
    assert.ok(status.capabilities.includes('agents'));
    assert.ok(status.capabilities.includes('provider-neutral-model-catalog'));
    assert.equal(await agentApi.supportsAgentManagement(), true);

    const catalog = await agentApi.listProviderModels();
    assert.deepEqual(catalog.map(({ providerId, modelId }) => [providerId, modelId]), [
      ['magpie', 'fixture/model-a'],
      ['magpie', 'fixture/model-b'],
    ]);
    assert.deepEqual(catalog[0]?.capabilities, ['chat', 'streaming-output']);

    const first = await agentApi.createAgent({
      name: 'Agent A',
      instructions: 'Use concise wording.',
      providerId: 'magpie',
      modelId: 'fixture/model-a',
    });
    const second = await agentApi.createAgent({
      name: 'Agent B',
      instructions: 'Explain every step.',
      providerId: 'magpie',
      modelId: 'fixture/model-b',
    });
    assert.notEqual(first.id, second.id);
    assert.equal(first.isDefault, true);
    assert.equal(second.isDefault, false);
    assert.equal((await agentApi.getDefaultAgent())?.id, first.id);

    const initialConfiguration = await configurationApi.getConfigurationState();
    assert.equal(initialConfiguration.revision.document.schemaVersion, 1);
    const initialRevisionId = initialConfiguration.revision.id;
    const firstTask = await taskApi.createTask({ prompt: 'Answer this.', agentId: first.id });
    const firstFinished = await waitForTerminalTask(taskApi.getTask, firstTask.id);
    assert.equal(firstFinished.state, 'succeeded');
    assert.equal(firstFinished.output, 'answer');
    assert.equal(firstFinished.agentId, first.id);
    assert.equal(firstFinished.agentRevisionId, first.currentRevisionId);
    assert.equal(firstFinished.providerId, 'magpie');
    assert.equal(firstFinished.modelId, 'fixture/model-a');
    assert.equal(firstFinished.configurationRevisionId, initialRevisionId);
    assert.match(gateway.requests[0]?.prompt ?? '', /Use concise wording/);
    assert.equal(gateway.requests[0]?.model, 'fixture/model-a');

    const overrideTask = await taskApi.createTask({
      prompt: 'Override this model.',
      agentId: first.id,
      modelOverride: { providerId: 'magpie', modelId: 'fixture/model-b' },
    });
    const overrideFinished = await waitForTerminalTask(taskApi.getTask, overrideTask.id);
    assert.equal(overrideFinished.modelId, 'fixture/model-b');
    assert.equal(overrideFinished.agentRevisionId, first.currentRevisionId);
    assert.equal(gateway.requests.at(-1)?.model, 'fixture/model-b');

    const secondTask = await taskApi.createTask({ prompt: 'Explain this.', agentId: second.id });
    const secondFinished = await waitForTerminalTask(taskApi.getTask, secondTask.id);
    assert.equal(secondFinished.agentId, second.id);
    assert.equal(secondFinished.agentRevisionId, second.currentRevisionId);
    assert.equal(secondFinished.modelId, 'fixture/model-b');
    assert.match(gateway.requests.at(-1)?.prompt ?? '', /Explain every step/);

    const queuedEvents = await fetch(`${runtime.origin}/v1/events`)
      .then((response) => response.json() as Promise<{
        readonly events: readonly {
          readonly taskId: string;
          readonly agentId?: string;
          readonly agentRevisionId?: string;
          readonly providerId?: string;
          readonly modelId?: string;
        }[];
      }>);
    const firstQueuedEvent = queuedEvents.events.find((event) => event.taskId === firstTask.id);
    assert.equal(firstQueuedEvent?.agentId, first.id);
    assert.equal(firstQueuedEvent?.agentRevisionId, first.currentRevisionId);
    assert.equal(firstQueuedEvent?.providerId, 'magpie');
    assert.equal(firstQueuedEvent?.modelId, 'fixture/model-a');

    const updated = await agentApi.updateAgent(first.id, first.currentRevisionId, {
      name: 'Agent A updated',
      instructions: 'Updated instructions.',
      providerId: 'magpie',
      modelId: 'fixture/model-a',
    });
    assert.notEqual(updated.currentRevisionId, first.currentRevisionId);
    await assert.rejects(
      agentApi.updateAgent(first.id, first.currentRevisionId, {
        name: 'Stale',
        instructions: '',
        providerId: 'magpie',
        modelId: 'fixture/model-a',
      }),
      /Agent 已被其他操作更新|Runtime 返回 HTTP 409/,
    );
    const duplicate = await agentApi.duplicateAgent(second.id);
    assert.notEqual(duplicate.id, second.id);
    assert.equal(duplicate.current.modelId, 'fixture/model-b');
    const rollback = await agentApi.applyAgentRevision(
      first.id,
      first.currentRevisionId,
      updated.currentRevisionId,
    );
    assert.notEqual(rollback.currentRevisionId, updated.currentRevisionId);
    assert.equal(rollback.current.instructions, 'Use concise wording.');
    assert.equal((await agentApi.setDefaultAgent(second.id))?.id, second.id);
    assert.equal(await agentApi.setDefaultAgent(null), null);

    const v2Validation = await configurationApi.validateConfiguration(v2Document('paired acceptance'));
    assert.equal(v2Validation.schemaVersion, 2);
    const appliedV2 = await configurationApi.applyConfiguration(v2Document('paired acceptance'));
    assert.equal(appliedV2.changed, true);
    const v2RevisionId = appliedV2.activeRevisionId;
    assert.notEqual(v2RevisionId, initialRevisionId);
    const agentTaskOnV2 = await taskApi.createTask({ prompt: 'Agent stays single turn.', agentId: second.id });
    const agentTaskOnV2Finished = await waitForTerminalTask(taskApi.getTask, agentTaskOnV2.id);
    assert.equal(agentTaskOnV2Finished.configurationRevisionId, v2RevisionId);
    assert.equal(agentTaskOnV2Finished.output, 'answer');
    assert.equal(gateway.requests.at(-1)?.model, 'fixture/model-b');

    const legacyV2 = await taskApi.createTask({ prompt: 'Legacy remains v2.', model: 'fixture/model-a' });
    const legacyV2Finished = await waitForTerminalTask(taskApi.getTask, legacyV2.id);
    assert.equal(legacyV2Finished.configurationRevisionId, v2RevisionId);
    assert.equal(legacyV2Finished.agentId, undefined);
    assert.match(legacyV2Finished.output ?? '', /^composition:cmp_/);

    const rolledBack = await configurationApi.rollbackConfiguration(initialRevisionId);
    assert.equal(rolledBack.activeRevisionId, initialRevisionId);
    const legacyV1 = await taskApi.createTask({ prompt: 'Legacy returns to v1.', model: 'fixture/model-a' });
    const legacyV1Finished = await waitForTerminalTask(taskApi.getTask, legacyV1.id);
    assert.equal(legacyV1Finished.configurationRevisionId, initialRevisionId);
    assert.equal(legacyV1Finished.output, 'answer');
    assert.deepEqual((await taskApi.listModels()).map(({ id }) => id), [
      'fixture/model-a',
      'fixture/model-b',
    ]);

    const unsupportedProviderTask = await fetch(`${runtime.origin}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Do not silently fall back.',
        agentId: second.id,
        modelOverride: { providerId: 'alternate', modelId: 'fixture/model-a' },
      }),
    });
    assert.equal(unsupportedProviderTask.status, 400);
    const taskList = await fetch(`${runtime.origin}/v1/tasks`)
      .then((response) => response.json() as Promise<{ readonly tasks: readonly TaskFixture[] }>);
    assert.equal(taskList.tasks.some((task) => task.prompt === 'Do not silently fall back.'), false);
    const invalidTask = await fetch(`${runtime.origin}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    assert.equal(invalidTask.status, 400);

    const archived = await agentApi.archiveAgent(first.id);
    assert.equal(archived.archived, true);
    assert.equal(archived.isDefault, false);
    const archivedStart = await fetch(`${runtime.origin}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Archived cannot start.', agentId: first.id }),
    });
    assert.equal(archivedStart.status, 409);
    const retried = await taskApi.retryTask(firstTask.id);
    const retriedFinished = await waitForTerminalTask(taskApi.getTask, retried.id);
    assert.equal(retriedFinished.state, 'succeeded');
    assert.equal(retriedFinished.attempt, 2);
    assert.equal(retriedFinished.agentRevisionId, first.currentRevisionId);
    assert.equal(retriedFinished.providerId, 'magpie');
    assert.equal(retriedFinished.modelId, 'fixture/model-a');
    assert.equal(retriedFinished.configurationRevisionId, initialRevisionId);
    assert.match(gateway.requests.at(-1)?.prompt ?? '', /Use concise wording/);

    const cancellationTask = await taskApi.createTask({
      prompt: 'Cancel this task.',
      agentId: second.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const cancellationRequested = await taskApi.cancelTask(cancellationTask.id);
    assert.ok(['cancelling', 'cancelled'].includes(cancellationRequested.state));
    const cancelled = await waitForTerminalTask(taskApi.getTask, cancellationTask.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.partialOutput, null);
    assert.equal(cancelled.agentRevisionId, second.currentRevisionId);
    const cancellationEvents = await fetch(`${runtime.origin}/v1/events`)
      .then((response) => response.json() as Promise<{
        readonly events: readonly { readonly taskId: string; readonly type: string }[];
      }>);
    assert.ok(cancellationEvents.events.some((event) => event.taskId === cancellationTask.id
      && event.type === 'task.cancellation_requested'));
    assert.ok(cancellationEvents.events.some((event) => event.taskId === cancellationTask.id
      && event.type === 'task.cancelled'));

    const interruptTask = await taskApi.createTask({
      prompt: 'Interrupt this task.',
      agentId: second.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const interrupted = await taskApi.getTask(interruptTask.id);
    assert.equal(interrupted.state, 'running');
    await runtime.close();
    runtime = await startRuntime(gateway.origin, databasePath);
    restoreFetch();
    restoreFetch = installFetchShim(runtime.origin);
    const interruptedAfterRestart = await taskApi.getTask(interruptTask.id);
    assert.equal(interruptedAfterRestart.state, 'interrupted');
    assert.match(interruptedAfterRestart.error ?? '', /Runtime restarted/);
    assert.equal(interrupted.agentRevisionId, second.currentRevisionId);
    const interruptedRetry = await taskApi.retryTask(interruptTask.id);
    const recovered = await waitForTerminalTask(taskApi.getTask, interruptedRetry.id);
    assert.equal(recovered.state, 'succeeded');
    assert.equal(recovered.attempt, 2);
    assert.equal(recovered.agentRevisionId, second.currentRevisionId);
    const replay = await fetch(`${runtime.origin}/v1/events`)
      .then((response) => response.json() as Promise<{
        readonly events: readonly { readonly taskId: string; readonly type: string }[];
      }>);
    assert.ok(replay.events.some((event) => event.taskId === interruptTask.id
      && event.type === 'task.interrupted'));
    assert.equal(runtime.service.store.listTasks().find((task) => task.id === firstTask.id)?.agentRevisionId,
      first.currentRevisionId);

    await runtime.close();
    runtime = undefined;
    const { stdout: cliOutput } = await execFileAsync(process.execPath, [
      '--import', 'tsx', path.join(repositoryRoot, 'src/cli.ts'), 'run', 'CLI compatibility task.',
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONCHBASE_DB: databasePath,
        CONCHBASE_MAGPIE_URL: gateway.origin,
        CONCHBASE_MODEL: 'fixture/model-a',
      },
      encoding: 'utf8',
    });
    const cliTask = JSON.parse(cliOutput) as TaskFixture;
    assert.equal(cliTask.state, 'succeeded');
    assert.equal(cliTask.output, 'answer');
    assert.equal(cliTask.agentId, undefined);
    assert.equal(gateway.requests.at(-1)?.model, 'fixture/model-a');

    runtime = await startRuntime(gateway.origin, databasePath);
    restoreFetch();
    restoreFetch = installFetchShim(runtime.origin);
    const agentsAfterCli = await agentApi.listAgents();
    assert.equal(agentsAfterCli.length, 3);
    assert.equal((await agentApi.getAgent(second.id)).revisions.length >= 1, true);
  } finally {
    restoreFetch?.();
    if (runtime) await runtime.close();
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
