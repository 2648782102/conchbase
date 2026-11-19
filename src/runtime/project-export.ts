/**
 * Export one project to a portable JSON document.
 *
 * This is the "archive/export" half of the project lifecycle: everything a
 * person needs to understand what a project was, what its workers produced, and
 * what state it ended in — with no private file contents and no secrets.
 */
import { writeFileSync } from 'node:fs';
import type { OrganizationSnapshot } from './organization-contract.js';
import { projectLifecycleView } from './project-lifecycle-view.js';
import { deterministicProjectSummary, projectSummaryFacts } from './project-summary.js';

export interface ProjectExport {
  readonly version: 1;
  readonly exportedAt: string;
  readonly projectId: string;
  readonly state: string;
  readonly nextAction: string | null;
  readonly summary: string;
  readonly workers: readonly { readonly id: string; readonly displayName: string; readonly state: string }[];
  readonly reports: readonly { readonly workerId: string; readonly state: string; readonly body: string }[];
  readonly attention: readonly { readonly id: string; readonly state: string }[];
}

export function buildProjectExport(
  snapshot: OrganizationSnapshot,
  projectId: string,
  options: {
    readonly purpose?: string;
    readonly reportTexts?: ReadonlyMap<string, string>;
    readonly now?: string;
  } = {},
): ProjectExport | null {
  const view = projectLifecycleView(snapshot, projectId);
  if (!view) return null;
  const facts = projectSummaryFacts(snapshot, projectId, options);
  const summary = deterministicProjectSummary(facts);
  const attention = snapshot.attentionRequests
    .filter((request) => request.projectId === projectId)
    .map((request) => ({ id: request.id, state: request.state }));
  return Object.freeze({
    version: 1,
    exportedAt: options.now ?? new Date().toISOString(),
    projectId,
    state: view.state,
    nextAction: view.nextAction,
    summary: [
      summary.headline,
      ...summary.outcomes.map((line) => `- ${line}`),
      ...(summary.openIssues.length > 0 ? ['待处理:', ...summary.openIssues.map((line) => `- ${line}`)] : []),
      ...(summary.nextSteps.length > 0 ? ['下一步:', ...summary.nextSteps.map((line) => `- ${line}`)] : []),
    ].join('\n'),
    workers: facts.workers.map((worker) => ({ id: worker.id, displayName: worker.displayName, state: worker.state })),
    reports: facts.reports.map((report) => ({ workerId: report.workerId, state: report.state, body: report.body })),
    attention,
  });
}

/** Writes the export to `target`; refuses to overwrite an existing file. */
export function exportProjectToFile(
  snapshot: OrganizationSnapshot,
  projectId: string,
  target: string,
  options: { readonly purpose?: string; readonly reportTexts?: ReadonlyMap<string, string> } = {},
): ProjectExport {
  const document = buildProjectExport(snapshot, projectId, options);
  if (!document) throw new Error(`project not found: ${projectId}`);
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return document;
}
