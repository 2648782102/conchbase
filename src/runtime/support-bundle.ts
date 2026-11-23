/**
 * A copy-pasteable support bundle.
 *
 * Everything here is already-public operational metadata: version, where the
 * data file is, and the outcome of the environment checks. It deliberately
 * carries no prompts, transcripts, task bodies, tool arguments, or secrets —
 * redaction happens here, in the Runtime, because a client cannot know what is
 * sensitive.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DiagnosticCheck, DiagnosticStatus } from './diagnostics.js';
import { CURRENT_DATABASE_SCHEMA_VERSION } from './task-store-migrations.js';
import { containsSecretLike } from './secret-filter.js';

export interface SupportBundle {
  readonly format: 'conchbase-support-bundle';
  readonly generatedAt: string;
  readonly version: string;
  readonly data: {
    readonly databasePath: string;
    readonly sizeBytes: number;
    readonly schemaVersion: number;
  };
  readonly runtime: {
    readonly host: string;
    readonly port: number;
    readonly magpieBaseUrl: string;
  };
  readonly checks: readonly { readonly id: string; readonly status: DiagnosticStatus; readonly detail: string }[];
  readonly summary: {
    readonly status: DiagnosticStatus;
    readonly nextStep: string | null;
  };
}

export async function buildSupportBundle(input: {
  readonly version: string;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly host: string;
  readonly port: number;
  readonly magpieBaseUrl: string;
  readonly checks: readonly DiagnosticCheck[];
  readonly generatedAt?: string;
}): Promise<SupportBundle> {
  const databasePath = path.resolve(input.databasePath);
  const failed = input.checks.filter((check) => check.status === 'fail');
  const warned = input.checks.filter((check) => check.status === 'warn');
  const status: DiagnosticStatus = failed.length > 0 ? 'fail' : warned.length > 0 ? 'warn' : 'ok';
  const firstIssue = failed[0] ?? warned[0];
  const safeChecks = input.checks.map((check) => Object.freeze({
    id: check.id,
    status: check.status,
    detail: containsSecretLike(check.detail) ? '(detail withheld: looks sensitive)' : check.detail,
  }));
  const safeFirstIssue = firstIssue
    ? safeChecks.find((check) => check.id === firstIssue.id && check.status === firstIssue.status)
    : undefined;
  return Object.freeze({
    format: 'conchbase-support-bundle',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    version: input.version,
    data: Object.freeze({
      databasePath,
      sizeBytes: existsSync(databasePath) ? statSync(databasePath).size : 0,
      schemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
    }),
    runtime: Object.freeze({ host: input.host, port: input.port, magpieBaseUrl: input.magpieBaseUrl }),
    checks: Object.freeze(safeChecks),
    summary: Object.freeze({
      status,
      nextStep: safeFirstIssue
        ? `检查 ${safeFirstIssue.id}：${safeFirstIssue.detail}`
        : null,
    }),
  });
}

export function formatSupportBundle(bundle: SupportBundle): string {
  const lines = [
    'Conchbase support bundle',
    `generated: ${bundle.generatedAt}`,
    `version:   ${bundle.version}`,
    `data:      ${bundle.data.databasePath} (${bundle.data.sizeBytes} bytes, schema ${bundle.data.schemaVersion})`,
    `runtime:   ${bundle.runtime.host}:${bundle.runtime.port}`,
    `gateway:   ${bundle.runtime.magpieBaseUrl}`,
    '',
    'checks:',
    ...bundle.checks.map((check) => `  [${check.status}] ${check.id}: ${check.detail}`),
    '',
    `summary: ${bundle.summary.status}${bundle.summary.nextStep ? ` — ${bundle.summary.nextStep}` : ''}`,
  ];
  return `${lines.join('\n')}\n`;
}
