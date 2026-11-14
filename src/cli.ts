#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createApp } from './http/create-app.js';
import { BossModeService } from './runtime/boss-mode-service.js';
import { ControlledExecutionService } from './runtime/controlled-execution.js';
import { IsolatedExecutionService } from './runtime/isolated-execution.js';
import { MagpieModelCatalog } from './runtime/model-catalog.js';
import { createTaskService } from './runtime/task-service.js';
import { createOpenAiCompatibleOrganizationIntentParser } from './runtime/organization-intent-parser.js';

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
  conchbase config               Show the active configuration revision
  conchbase config-revisions     List configuration revision summaries

Configuration:
  CONCHBASE_MAGPIE_URL           Local Magpie gateway (default http://127.0.0.1:3425)
  CONCHBASE_MAGPIE_APP_KEY       Optional app-naming key (magpie-<app-id>)
  CONCHBASE_MODEL                Model id; run and models do not require it
  CONCHBASE_ORGANIZATION_INTENT_MODEL   Optional structured model for Boss-mode intents
  CONCHBASE_DB                   Runtime SQLite path (default .conchbase/runtime.sqlite)
  CONCHBASE_ALLOW_AUTHENTICATED_REMOTE_BINDING=1   Enable reviewed non-loopback binding
  CONCHBASE_AUTH_TOKEN_DIGEST    sha256 digest of an approved bearer token
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
): BossModeService {
  const parser = config.organizationIntentModel
    ? createOpenAiCompatibleOrganizationIntentParser({
      baseUrl: config.magpieBaseUrl,
      model: config.organizationIntentModel,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    })
    : undefined;
  return new BossModeService(service.store.organization, service, parser ? { parser } : {});
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  const config = loadRuntimeConfig();
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }

  if (command === 'serve') {
    mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const service = createTaskService(config.databasePath, {
      magpieBaseUrl: config.magpieBaseUrl,
      ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
      defaultModel: config.defaultModel,
    });
    const bossMode = createBossModeService(service, config);
    const executionService = new ControlledExecutionService();
    const executionRunService = new IsolatedExecutionService({ host: executionService });
    const app = createApp({
      taskService: service,
      config,
      bossModeService: bossMode,
      executionService,
      executionRunService,
    });
    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (cause) {
      service.close();
      throw cause;
    }
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
  const service = createTaskService(config.databasePath, {
    magpieBaseUrl: config.magpieBaseUrl,
    ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
    defaultModel: config.defaultModel,
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  try {
    if (command === 'boss') {
      const text = args.join(' ').trim();
      if (!text) throw new Error('Boss-mode intent must not be empty.');
      const bossMode = createBossModeService(service, config);
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
