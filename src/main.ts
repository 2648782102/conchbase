#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createApp } from './http/create-app.js';
import { createTaskService } from './runtime/task-service.js';
import { BossModeService } from './runtime/boss-mode-service.js';
import { ControlledExecutionService } from './runtime/controlled-execution.js';
import { IsolatedExecutionService } from './runtime/isolated-execution.js';
import { PrimaryConversationService } from './runtime/primary-conversation.js';
import { createOpenAiCompatibleOrganizationIntentParser } from './runtime/organization-intent-parser.js';

const config = loadRuntimeConfig();
mkdirSync(path.dirname(config.databasePath), { recursive: true });
const taskService = createTaskService(config.databasePath, {
  magpieBaseUrl: config.magpieBaseUrl,
  ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
  defaultModel: config.defaultModel,
});
const executionService = new ControlledExecutionService();
const executionRunService = new IsolatedExecutionService({ host: executionService });
const conversationService = new PrimaryConversationService();
let servingApp = createApp({
  taskService,
  config,
  executionService,
  executionRunService,
  conversationService,
});

if (config.organizationIntentModel) {
  const parser = createOpenAiCompatibleOrganizationIntentParser({
    baseUrl: config.magpieBaseUrl,
    model: config.organizationIntentModel,
    ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
  });
  const bossMode = new BossModeService(taskService.store.organization, taskService, {
    parser,
    conversation: { recordIntentText: (intentId, text) => conversationService.recordIntentText(intentId, text) },
  });
  servingApp = createApp({
    taskService,
    config,
    bossModeService: bossMode,
    executionService,
    executionRunService,
    conversationService,
  });
}

await servingApp.listen(config);
