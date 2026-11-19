/**
 * Operator-facing data and diagnostics routes.
 *
 * These stay bounded and redacted: they report where the data lives and whether
 * it can be copied, never its contents. Backup writes exactly one file, at a
 * caller-named absolute path outside the live database, and returns a
 * verification summary rather than the file body.
 */
import type { FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { TaskService } from '../../../runtime/task-service.js';
import { backupOpenDatabase, inspectBackup } from '../../../runtime/backup.js';
import { buildDiagnosticChecks, defaultDiagnosticContext } from '../../../runtime/diagnostics.js';
import type { RuntimeConfig } from '../../../config/runtime-config.js';

export function registerOperationsRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
  config: RuntimeConfig | undefined,
): void {
  const unavailable = (reply: { code(s: number): { send(p: unknown): unknown } }) =>
    reply.code(503).send({ error: 'Runtime data is not configured.' });

  app.get('/v1/operations/data', async (_request, reply) => {
    if (!config || !taskService) return unavailable(reply);
    const file = config.databasePath;
    const exists = existsSync(file);
    const sizeBytes = exists ? statSync(file).size : 0;
    return reply.send({
      version: 1,
      databasePath: path.resolve(file),
      sizeBytes,
      // The schema version is what a support flow needs to know before advising
      // an upgrade; it is not sensitive.
      schemaVersion: 9,
      exists,
    });
  });

  app.post<{ Body: { target?: unknown } }>('/v1/operations/backup', async (request, reply) => {
    if (!config || !taskService) return unavailable(reply);
    const raw = request.body?.target;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return reply.code(400).send({ error: 'target must be a non-empty absolute path.' });
    }
    const target = path.resolve(raw);
    // Only an absolute, non-database destination is acceptable. A relative path
    // would resolve against the server's cwd, which the client cannot see.
    if (!path.isAbsolute(raw) || target === path.resolve(config.databasePath)) {
      return reply.code(400).send({ error: 'target must be an absolute path other than the live database.' });
    }
    if (existsSync(target)) {
      return reply.code(400).send({ error: 'target already exists; refusing to overwrite a file.' });
    }
    try {
      taskService.store.backupTo(target);
    } catch {
      return reply.code(500).send({ error: 'backup failed.' });
    }
    const report = inspectBackup(target);
    return reply.code(201).send({
      version: 1,
      ok: report.ok,
      target,
      sizeBytes: existsSync(target) ? statSync(target).size : 0,
      tables: report.tables,
      counts: report.counts,
      integrity: report.integrity,
      ...(report.error ? { error: report.error } : {}),
    });
  });

  app.get('/v1/operations/diagnostics', async (_request, reply) => {
    if (!config) return unavailable(reply);
    const checks = await buildDiagnosticChecks(defaultDiagnosticContext({
      databasePath: config.databasePath,
      workspaceRoot: config.workspaceRoot,
      port: config.port,
      host: config.host,
      magpieBaseUrl: config.magpieBaseUrl,
      consolePort: config.port === 4318 ? 5173 : 5173 + (config.port - 4318),
    }));
    return reply.send({
      version: 1,
      checks: checks.map((check) => ({ id: check.id, status: check.status, detail: check.detail })),
    });
  });
}
