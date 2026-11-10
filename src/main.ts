#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createApp } from './http/create-app.js';
import { createTaskService } from './runtime/task-service.js';

const config = loadRuntimeConfig();
mkdirSync(path.dirname(config.databasePath), { recursive: true });
const taskService = createTaskService(config.databasePath, {
  magpieBaseUrl: config.magpieBaseUrl,
  ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
  defaultModel: config.defaultModel,
});
const app = createApp({ taskService, config });

await app.listen(config);
