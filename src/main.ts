#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createApp } from './http/create-app.js';
import { createTaskService } from './runtime/task-service.js';
import { createAutomaticBackup } from './runtime/automatic-backup.js';
import { BOSS_UPSTREAM_PROVIDER_ID, BossModeService } from './runtime/boss-mode-service.js';
import { ControlledExecutionService } from './runtime/controlled-execution.js';
import { IsolatedExecutionService } from './runtime/isolated-execution.js';
import { PrimaryConversationService } from './runtime/primary-conversation.js';
import {
  createOpenAiCompatibleBossConversationParser,
  createOpenAiCompatibleOrganizationIntentParser,
} from './runtime/organization-intent-parser.js';
import { createToolRuntime } from './runtime/tool-runtime.js';
import { defaultWorkerGrants } from './runtime/capability-grants.js';
import { createConvergenceRuntime } from './runtime/organization-convergence-runtime.js';
import { AgentChatService } from './runtime/agent-chat.js';
import { createOpenAiCompatibleMemoryReviewer } from './runtime/memory-review.js';
import { assertSupportedNode } from './runtime/node-version.js';

assertSupportedNode();

const config = loadRuntimeConfig();
mkdirSync(path.dirname(config.databasePath), { recursive: true });
// The workspace root must exist before any tool call: a worker that cannot list
// its own root reports `not_found` for everything and produces nothing.
mkdirSync(config.workspaceRoot, { recursive: true });
const toolRuntime = await createToolRuntime({
  root: config.workspaceRoot,
  ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {}),
  ...(config.skillsDirectory ? { skillsDirectory: config.skillsDirectory } : {}),
  ...(config.allowToolWrites ? { allowWrites: true } : {}),
  ...(config.enableGitTools ? { enableGit: true } : {}),
});
const taskService = createTaskService(config.databasePath, {
  magpieBaseUrl: config.magpieBaseUrl,
  ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
  ...(config.providerEndpoints ? { providers: config.providerEndpoints } : {}),
  defaultModel: config.defaultModel,
  executionMode: config.executionMode,
  ...(config.permissionLevel ? { permissionLevel: config.permissionLevel } : {}),
  loopBudget: config.loopBudget,
  ...(config.maxConcurrentTasks ? { maxConcurrentTasks: config.maxConcurrentTasks } : {}),
  }, { tools: toolRuntime.tools, skills: toolRuntime.skills.skills });
const executionService = new ControlledExecutionService();
const executionRunService = new IsolatedExecutionService({ host: executionService });
const conversationService = new PrimaryConversationService({
  recordIntentText: (intentId, text) => taskService.store.organization.recordIntentText?.(intentId, text),
  intentTexts: () => taskService.store.organization.intentTexts?.() ?? new Map(),
});
let servingApp = createApp({
  taskService,
  config,
  executionService,
  executionRunService,
  conversationService,
});
let convergence: { start(): void; stop(): void } | undefined;

if (config.organizationIntentModel || config.bossModel || config.defaultModel) {
  const parser = config.organizationIntentModel
    ? createOpenAiCompatibleOrganizationIntentParser({
      baseUrl: config.magpieBaseUrl,
      model: config.organizationIntentModel,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    })
    : createOpenAiCompatibleBossConversationParser({
      baseUrl: config.magpieBaseUrl,
      model: config.bossModel ?? config.defaultModel,
      timeoutMs: 30_000,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    });
  const bossMode = new BossModeService(taskService.store.organization, taskService, {
    parser,
    memory: taskService.store.memory,
    // The reviewer is an independent, disposable check on whether a proposed
    // memory is a durable preference. It recommends; the Runtime still decides.
    memoryReviewer: createOpenAiCompatibleMemoryReviewer({
      baseUrl: config.magpieBaseUrl,
      model: config.bossModel ?? config.defaultModel,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    }),
    bossModelReference: { providerId: BOSS_UPSTREAM_PROVIDER_ID, modelId: config.bossModel ?? config.defaultModel },
    workerCapabilityGrants: () => defaultWorkerGrants(toolRuntime.tools, toolRuntime.skills.skills, { allowWrites: config.allowToolWrites === true }),
    conversation: { recordIntentText: (intentId, text) => conversationService.recordIntentText(intentId, text) },
  });
  // One instance only. AgentChatService caches conversations in memory, so the
  // API and the convergence sweeper must share it: two instances produced two
  // divergent views and the Runtime notice never appeared in the user's chat.
  const agentChat = new AgentChatService(taskService, bossMode);
  servingApp = createApp({
    taskService,
    config,
    bossModeService: bossMode,
    agentChatService: agentChat,
    executionService,
    executionRunService,
    conversationService,
  });
  convergence = createConvergenceRuntime({
    store: taskService.store.organization,
    taskService,
    agentChat,
    policy: { idleAfterMs: config.projectIdleMs, convergeWithOpenAttention: false },
    memory: taskService.store.memory,
    summaryModel: {
      baseUrl: config.magpieBaseUrl,
      model: config.bossModel ?? config.defaultModel,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    },
  });
  convergence?.start();
}

await servingApp.listen(config);

// Automatic snapshots run on the live connection: the database has exactly one
// owner, so nothing else may open it. A failure is recorded, never thrown.
const backupIntervalMs = config.backupIntervalMs ?? 24 * 60 * 60 * 1000;
const automaticBackup = backupIntervalMs > 0
  ? createAutomaticBackup({
    store: taskService.store,
    directory: config.backupDirectory ?? path.join(path.dirname(config.databasePath), 'backups'),
    keep: config.backupKeep ?? 7,
    intervalMs: backupIntervalMs,
  })
  : null;
automaticBackup?.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Await the in-flight snapshot before exiting, otherwise a shutdown that
    // lands mid-backup leaves a half-written file behind.
    void (async () => {
      await automaticBackup?.stop();
      convergence?.stop();
      process.exit(0);
    })();
  });
}
