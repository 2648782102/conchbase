#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createApp } from './http/create-app.js';
import { BOSS_UPSTREAM_PROVIDER_ID, BossModeService } from './runtime/boss-mode-service.js';
import { ControlledExecutionService } from './runtime/controlled-execution.js';
import { IsolatedExecutionService } from './runtime/isolated-execution.js';
import { PrimaryConversationService } from './runtime/primary-conversation.js';
import { MagpieModelCatalog } from './runtime/model-catalog.js';
import { createTaskService } from './runtime/task-service.js';
import {
  createOpenAiCompatibleBossConversationParser,
  createOpenAiCompatibleOrganizationIntentParser,
} from './runtime/organization-intent-parser.js';
import { createToolRuntime } from './runtime/tool-runtime.js';
import { defaultWorkerGrants } from './runtime/capability-grants.js';
import { createConvergenceRuntime } from './runtime/organization-convergence-runtime.js';
import { AgentChatService } from './runtime/agent-chat.js';
import { createOpenAiCompatibleMemoryReviewer } from './runtime/memory-review.js';
import { createAutomaticBackup } from './runtime/automatic-backup.js';
import { assertSupportedNode } from './runtime/node-version.js';

assertSupportedNode();

function usage(): string {
  return `Conchbase 1.0.0

Usage:
  conchbase serve                 Start the local Runtime API
  conchbase run <prompt>          Run one model task directly and print its result
  conchbase boss <prompt>         Submit one primary-conversation Boss-mode intent
  conchbase organization          Print the published organization snapshot
  conchbase models               List models from the local Magpie gateway
  conchbase tasks                List persisted tasks
  conchbase task <id>            Show one task
  conchbase events [cursor]      Show events after an optional event ID
  conchbase retry <id>           Retry a terminal task directly
  conchbase diagnose             Check Node, paths, port, and provider connectivity
  conchbase status               Report whether a Runtime is up on the configured port
  conchbase start                Start the Runtime in the background
  conchbase stop                 Stop the background Runtime
  conchbase logs [lines]         Show the background Runtime's recent log
  conchbase backup <path>        Write a consistent snapshot of the database
  conchbase verify-backup <path> Check a backup's tables, rows, and integrity
  conchbase restore-backup <path>  Replace the live database with a verified snapshot
  conchbase export-project <id> <path>  Export one project to a JSON file
  conchbase config               Show the active configuration revision
  conchbase config-revisions     List configuration revision summaries

Configuration:
  CONCHBASE_MAGPIE_URL           Local Magpie gateway (default http://127.0.0.1:3425)
  CONCHBASE_MAGPIE_APP_KEY       Optional app-naming key (magpie-<app-id>)
  CONCHBASE_MODEL                Model id; run and models do not require it
  CONCHBASE_ORGANIZATION_INTENT_MODEL   Optional structured model for Boss-mode intents
  CONCHBASE_BOSS_MODEL                  Optional model for natural 老板 Agent conversation
  CONCHBASE_DB                   Runtime SQLite path (default .conchbase/runtime.sqlite)
  CONCHBASE_ALLOW_AUTHENTICATED_REMOTE_BINDING=1   Enable reviewed non-loopback binding
  CONCHBASE_AUTH_TOKEN_DIGEST    sha256 digest of an approved bearer token
  CONCHBASE_EXECUTION_MODE       restricted (default) or unrestricted
  CONCHBASE_PERMISSION_LEVEL     strict, standard (default), or trusted
  CONCHBASE_BACKUP_INTERVAL_MS   Automatic snapshot interval (default 86400000; 0 disables)
  CONCHBASE_BACKUP_KEEP          Snapshots to retain (default 7)
  CONCHBASE_BACKUP_DIR           Snapshot directory (default backups/ beside the database)
  CONCHBASE_MAX_ITERATIONS       Agent loop iteration ceiling (default 6, max 64)
  CONCHBASE_MAX_TOOL_CALLS_PER_TURN   Tool calls per turn (default 4, max 16)
  CONCHBASE_LOOP_DEADLINE_MS     Agent loop wall-clock budget (default 120000)
`;
}

function requireModel(config: ReturnType<typeof loadRuntimeConfig>): string {
  if (!config.defaultModel) {
    throw new Error('Set CONCHBASE_MODEL to a model id from `conchbase models`.');
  }
  return config.defaultModel;
}

function createBossModeService(
  service: ReturnType<typeof createTaskService>,
  config: ReturnType<typeof loadRuntimeConfig>,
  conversation: PrimaryConversationService,
  toolRuntime: Awaited<ReturnType<typeof createToolRuntime>>,
): BossModeService {
  const parser = config.organizationIntentModel
    ? createOpenAiCompatibleOrganizationIntentParser({
      baseUrl: config.magpieBaseUrl,
      model: config.organizationIntentModel,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    })
    : config.bossModel ?? config.defaultModel
      ? createOpenAiCompatibleBossConversationParser({
        baseUrl: config.magpieBaseUrl,
        model: config.bossModel ?? config.defaultModel,
        timeoutMs: 30_000,
        ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
      })
      : undefined;
  return new BossModeService(service.store.organization, service, {
    ...(parser ? { parser } : {}),
    memory: service.store.memory,
    memoryReviewer: createOpenAiCompatibleMemoryReviewer({
      baseUrl: config.magpieBaseUrl,
      model: config.bossModel ?? config.defaultModel,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    }),
    bossModelReference: { providerId: BOSS_UPSTREAM_PROVIDER_ID, modelId: config.bossModel ?? config.defaultModel },
    schedulerLimits: {
      globalActive: config.globalActiveWork,
      perProjectActive: config.perProjectActiveWork,
    },
    workerSliceIterations: config.workerSliceIterations,
    workerCapabilityGrants: () => defaultWorkerGrants(toolRuntime.tools, toolRuntime.skills.skills, { allowWrites: config.allowToolWrites === true }),
    conversation: { recordIntentText: (intentId, text) => conversation.recordIntentText(intentId, text) },
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  const config = loadRuntimeConfig();
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }

  if (command === 'start' || command === 'stop' || command === 'logs') {
    const proc = await import('./runtime/runtime-process.js');
    const paths = proc.runtimeProcessPaths(config.databasePath);
    if (command === 'start') {
      const started = proc.startBackground({
        executable: process.execPath,
        args: proc.buildServeArgs(process.argv[1] ?? 'dist/cli.js'),
        cwd: process.cwd(),
        env: process.env,
        paths,
      });
      process.stdout.write(`started Runtime pid ${started.pid}\nlog: ${started.logFile}\n`);
      return;
    }
    if (command === 'stop') {
      const result = await proc.stopBackground({ paths });
      process.stdout.write(`${result.detail}\n`);
      process.exitCode = result.stopped ? 0 : 1;
      return;
    }
    const lines = Number(args[0] ?? '50');
    process.stdout.write(proc.tailLog(paths.logFile, Number.isInteger(lines) ? lines : 50));
    return;
  }

  if (command === 'status') {
    const { probeRuntimeStatus, formatRuntimeStatus } = await import('./runtime/runtime-probe.js');
    const baseUrl = `http://${config.host}:${config.port}`;
    const status = await probeRuntimeStatus({ baseUrl });
    process.stdout.write(formatRuntimeStatus(status));
    process.exitCode = status.healthy ? 0 : 1;
    return;
  }

  if (command === 'verify-backup') {
    const { inspectBackup, formatBackupReport } = await import('./runtime/backup.js');
    const target = args[0];
    if (!target) throw new Error('Usage: conchbase verify-backup <path>');
    const report = inspectBackup(target);
    process.stdout.write(formatBackupReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === 'restore-backup') {
    const { restoreBackup, formatBackupReport } = await import('./runtime/backup.js');
    const { probeRuntimeStatus } = await import('./runtime/runtime-probe.js');
    const source = args[0];
    if (!source) throw new Error('Usage: conchbase restore-backup <path>');
    // A live owner holds the only write connection and keeps writing to the
    // inode this command is about to replace, so restoring under it would
    // silently lose whatever it wrote next. `running` (not `healthy`) is the
    // right test: a process answering 503 still owns the file.
    const status = await probeRuntimeStatus({ baseUrl: `http://${config.host}:${config.port}` });
    if (status.running) {
      throw new Error('a Runtime is serving on this database; run `conchbase stop` first.');
    }
    mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const result = restoreBackup(source, config.databasePath);
    process.stdout.write([
      `restored ${path.resolve(source)} → ${path.resolve(config.databasePath)}`,
      ...(result.movedPreviousTo ? [`previous database kept at ${result.movedPreviousTo}`] : []),
      formatBackupReport(result.report).trimEnd(),
      '',
    ].join('\n'));
    return;
  }

  if (command === 'serve') {
    mkdirSync(path.dirname(config.databasePath), { recursive: true });
    // Tools cannot read a root that does not exist yet.
    mkdirSync(config.workspaceRoot, { recursive: true });
    const toolRuntime = await createToolRuntime({
      root: config.workspaceRoot,
      ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {}),
  ...(config.skillsDirectory ? { skillsDirectory: config.skillsDirectory } : {}),
  ...(config.allowToolWrites ? { allowWrites: true } : {}),
  ...(config.enableGitTools ? { enableGit: true } : {}),
    });
    const service = createTaskService(config.databasePath, {
      magpieBaseUrl: config.magpieBaseUrl,
      ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
      ...(config.providerEndpoints ? { providers: config.providerEndpoints } : {}),
      defaultModel: config.defaultModel,
      executionMode: config.executionMode,
      ...(config.permissionLevel ? { permissionLevel: config.permissionLevel } : {}),
      loopBudget: config.loopBudget,
      ...(config.maxConcurrentTasks ? { maxConcurrentTasks: config.maxConcurrentTasks } : {}),
      }, { tools: toolRuntime.tools, skills: toolRuntime.skills.skills });
    const conversationService = new PrimaryConversationService({
      recordIntentText: (intentId, text) => service.store.organization.recordIntentText?.(intentId, text),
      intentTexts: () => service.store.organization.intentTexts?.() ?? new Map(),
    });
    const bossMode = createBossModeService(service, config, conversationService, toolRuntime);
    const executionService = new ControlledExecutionService();
    const executionRunService = new IsolatedExecutionService({ host: executionService });
    // AgentChatService caches conversations in memory; the API and the
    // convergence sweeper must share one instance or a Runtime notice is
    // written into a cache the user never reads.
    const agentChat = new AgentChatService(service, bossMode);
    const convergence = createConvergenceRuntime({
      store: service.store.organization,
      taskService: service,
      agentChat,
      policy: { idleAfterMs: config.projectIdleMs, convergeWithOpenAttention: false },
      memory: service.store.memory,
      summaryModel: {
        baseUrl: config.magpieBaseUrl,
        model: config.bossModel ?? config.defaultModel,
        ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
      },
    });
    convergence.start();
    const app = createApp({
      taskService: service,
      config,
      bossModeService: bossMode,
      agentChatService: agentChat,
      executionService,
      executionRunService,
      conversationService,
    });
    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (cause) {
      convergence.stop();
      service.close();
      throw cause;
    }
    // Automatic snapshots go through the live connection: the database has
    // exactly one owner, so no external process may open it. A failure is
    // recorded in `status()`, never thrown into the task loop.
    const backupIntervalMs = config.backupIntervalMs ?? 24 * 60 * 60 * 1000;
    const automaticBackup = backupIntervalMs > 0
      ? createAutomaticBackup({
        store: service.store,
        directory: config.backupDirectory ?? path.join(path.dirname(config.databasePath), 'backups'),
        keep: config.backupKeep ?? 7,
        intervalMs: backupIntervalMs,
      })
      : null;
    automaticBackup?.start();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void (async () => {
          // Await an in-flight snapshot before exiting; a shutdown that lands
          // mid-backup would otherwise leave a half-written file behind.
          await automaticBackup?.stop();
          convergence.stop();
          // SSE streams can hold the listener open, and a tool call can be
          // mid-flight. Both are bounded so a stuck client cannot turn a stop
          // into a hang; `stop()` aborts in-flight tasks and closes the store.
          await Promise.race([
            app.close(),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
          await Promise.race([
            service.stop(),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
          process.exit(0);
        })();
      });
    }
    return;
  }

  if (command === 'diagnose') {
    const { runDiagnostics } = await import('./runtime/diagnostics.js');
    process.exitCode = await runDiagnostics(config);
    return;
  }

  if (command === 'models') {
    const catalog = new MagpieModelCatalog({
      baseUrl: config.magpieBaseUrl,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    });
    const models = await catalog.listModels();
    for (const model of models) process.stdout.write(`${model.id}\t${model.displayName}\n`);
    return;
  }

  mkdirSync(path.dirname(config.databasePath), { recursive: true });
  mkdirSync(config.workspaceRoot, { recursive: true });
  const toolRuntime = await createToolRuntime({
    root: config.workspaceRoot,
    ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {}),
  ...(config.skillsDirectory ? { skillsDirectory: config.skillsDirectory } : {}),
  ...(config.allowToolWrites ? { allowWrites: true } : {}),
  ...(config.enableGitTools ? { enableGit: true } : {}),
  });
  const service = createTaskService(config.databasePath, {
    magpieBaseUrl: config.magpieBaseUrl,
    ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
    ...(config.providerEndpoints ? { providers: config.providerEndpoints } : {}),
    defaultModel: config.defaultModel,
    executionMode: config.executionMode,
    ...(config.permissionLevel ? { permissionLevel: config.permissionLevel } : {}),
    loopBudget: config.loopBudget,
    ...(config.maxConcurrentTasks ? { maxConcurrentTasks: config.maxConcurrentTasks } : {}),
    }, { tools: toolRuntime.tools, skills: toolRuntime.skills.skills });
  const conversationService = new PrimaryConversationService();
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  try {
    if (command === 'boss') {
      const text = args.join(' ').trim();
      if (!text) throw new Error('Boss-mode intent must not be empty.');
      const bossMode = createBossModeService(service, config, conversationService, toolRuntime);
      const result = await bossMode.submit({
        text,
        idempotencyKey: `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.executions.some((execution) => execution.status === 'failed')) process.exitCode = 1;
      return;
    }
    if (command === 'organization') {
      process.stdout.write(`${JSON.stringify(service.store.organization.get(), null, 2)}\n`);
      return;
    }
    if (command === 'run') {
      const prompt = args.join(' ').trim();
      const model = requireModel(config);
      const finished = await service.createTaskAndWait(
        { prompt, model },
        controller.signal,
      );
      process.stdout.write(`${JSON.stringify(finished, null, 2)}\n`);
      if (finished.state !== 'succeeded') process.exitCode = 1;
      return;
    }
    if (command === 'tasks') {
      process.stdout.write(`${JSON.stringify(service.store.listTasks(), null, 2)}\n`);
      return;
    }
    if (command === 'export-project') {
      const [projectId, target] = args;
      if (!projectId || !target) throw new Error('Usage: conchbase export-project <id> <path>');
      const { exportProjectToFile } = await import('./runtime/project-export.js');
      exportProjectToFile(service.store.organization.get(), projectId, target);
      process.stdout.write(`exported ${projectId} to ${target}\n`);
      return;
    }
    if (command === 'backup') {
      const target = args[0];
      if (!target) throw new Error('Usage: conchbase backup <path>');
      service.store.backupTo(target);
      process.stdout.write(`backup written to ${target}\n`);
      return;
    }
    if (command === 'config') {
      process.stdout.write(`${JSON.stringify(service.getConfigurationState().active, null, 2)}\n`);
      return;
    }
    if (command === 'config-revisions') {
      process.stdout.write(`${JSON.stringify(service.getConfigurationState().history, null, 2)}\n`);
      return;
    }
    if (command === 'task') {
      const task = service.store.getTask(args[0] ?? '');
      if (!task) throw new Error('Task not found.');
      process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
      return;
    }
    if (command === 'events') {
      process.stdout.write(`${JSON.stringify(service.store.listEvents(args[0] ?? null), null, 2)}\n`);
      return;
    }
    if (command === 'retry') {
      requireModel(config);
      const task = service.retryTask(args[0] ?? '');
      service.startTask(task.id);
      const finished = await service.waitForTask(task.id, controller.signal);
      process.stdout.write(`${JSON.stringify(finished, null, 2)}\n`);
      if (finished.state !== 'succeeded') process.exitCode = 1;
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    service.close();
  }
}

await main(process.argv.slice(2)).catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : 'Command failed.'}\n`);
  process.exitCode = 1;
});
