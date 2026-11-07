#!/usr/bin/env node
import { loadRuntimeConfig } from './config/runtime-config.js';
import { createApp } from './http/create-app.js';

const config = loadRuntimeConfig();
const app = createApp();

await app.listen(config);
