#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createApp } from './http/create-app.js';
import { MagpieModelCatalog } from './runtime/model-catalog.js';
import { createTaskService } from './runtime/task-service.js';

function usage(): string {
  return `Conchbase 0.4.0

Usage:
  conchbase serve                 Start the local Runtime API
  conchbase run <prompt>          Run one model task directly and print its result
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
  CONCHBASE_DB                   Runtime SQLite path (default .conchbase/runtime.sqlite)
`;
}

function requireModel(config: ReturnType<typeof loadRuntimeConfig>): string {
  if (!config.defaultModel) {
    throw new Error('Set CONCHBASE_MODEL to a model id from `conchbase models`.');
  }
  return config.defaultModel;
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
    const app = createApp({ taskService: service });
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
