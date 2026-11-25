import { containsSecretLike } from './secret-filter.js';

export interface ProjectFact {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly body: string;
  readonly sourceReportId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const PROJECT_FACT_LIMITS = Object.freeze({
  keyChars: 80,
  bodyChars: 1200,
  factsPerProject: 24,
});

function normalizeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, PROJECT_FACT_LIMITS.keyChars);
  return key.length > 0 ? key : null;
}

function normalizeBody(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const body = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, PROJECT_FACT_LIMITS.bodyChars);
  if (body.length === 0 || containsSecretLike(body)) return null;
  return body;
}

export function promoteProjectFact(input: {
  readonly projectId: string;
  readonly key: unknown;
  readonly body: unknown;
  readonly sourceReportId?: string;
  readonly now?: () => string;
}): ProjectFact | null {
  const key = normalizeKey(input.key);
  const body = normalizeBody(input.body);
  if (!key || !body || input.projectId.trim().length === 0) return null;
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  return Object.freeze({
    id: `pf_${input.projectId}:${key}`,
    projectId: input.projectId,
    key,
    body,
    sourceReportId: input.sourceReportId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function upsertProjectFact(
  facts: readonly ProjectFact[],
  next: ProjectFact,
): readonly ProjectFact[] {
  const kept = facts.filter((fact) => fact.id !== next.id);
  const preserved = kept.find((fact) => fact.projectId === next.projectId && fact.key === next.key);
  const merged = preserved ? Object.freeze({ ...next, createdAt: preserved.createdAt }) : next;
  const byProject = [...kept.filter((fact) => fact.projectId === next.projectId), merged]
    .slice(-PROJECT_FACT_LIMITS.factsPerProject);
  return Object.freeze([
    ...kept.filter((fact) => fact.projectId !== next.projectId),
    ...byProject,
  ]);
}

export function projectFactsFor(
  facts: readonly ProjectFact[],
  projectIds: readonly string[],
): readonly ProjectFact[] {
  const allowed = new Set(projectIds);
  return Object.freeze(facts.filter((fact) => allowed.has(fact.projectId)).slice(-PROJECT_FACT_LIMITS.factsPerProject));
}
