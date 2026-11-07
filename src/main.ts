import { buildApp } from './app.js';

const host = process.env.CONCHBASE_HOST ?? '127.0.0.1';
const port = Number(process.env.CONCHBASE_PORT ?? 4318);

if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('This scaffold only supports loopback binding until API authentication is implemented.');
}

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('CONCHBASE_PORT must be an integer between 1 and 65535.');
}

const app = buildApp();
await app.listen({ host, port });
