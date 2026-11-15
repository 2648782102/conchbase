import type { OrganizationSnapshot } from './organization-contract.js';
import { containsSecretLike } from './secret-filter.js';

export const PROJECT_SUMMARY_VERSION = 1;

/**
 * A project-level close-out report.
 *
 * This is deliberately distinct from a worker's `OrganizationReport`: a worker
 * report describes one task, while this describes what the project as a whole
 * produced, what is still open, and what would happen next if the user resumed
 * it. It is written once, at convergence, and preserved as history.
 */
export interface ProjectSummaryDocument {
  readonly version: typeof PROJECT_SUMMARY_VERSION;
  readonly projectId: string;
  readonly headline: string;
  readonly outcomes: readonly string[];
  readonly openIssues: readonly string[];
  readonly nextSteps: readonly string[];
  /** `model` when a summarizer produced it, `runtime` for the deterministic fallback. */
  readonly source: 'model' | 'runtime';
}

export interface ProjectSummaryFacts {
  readonly projectId: string;
  readonly purpose: string;
  readonly workers: readonly { readonly id: string; readonly displayName: string; readonly state: string }[];
  readonly reports: readonly {
    readonly workerId: string;
    readonly state: string;
    readonly body: string;
  }[];
}

const MAX_HEADLINE = 240;
const MAX_BULLET = 320;
const MAX_OUTCOMES = 6;
const MAX_OPEN_ISSUES = 4;
const MAX_NEXT_STEPS = 3;
const MAX_RENDERED = 3_800;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length === 0 || text.length > max) return null;
  if (containsSecretLike(text)) return null;
  return text;
}

function boundedList(value: unknown, maxItems: number, maxLength: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items: string[] = [];
  for (const candidate of value) {
    const text = boundedText(candidate, maxLength);
    if (text === null) return null;
    items.push(text);
  }
  return Object.freeze(items);
}

/**
 * Validates a model-produced project summary.
 *
 * The model writes prose, but the shape is Runtime-owned: a summary that is
 * missing a field, over a bound, or carries a secret-like string is rejected
 * rather than partially trusted. A rejected summary falls back to the
 * deterministic one.
 */
export function parseProjectSummary(
  projectId: string,
  value: unknown,
): ProjectSummaryDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(['headline', 'outcomes', 'openIssues', 'nextSteps']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const headline = boundedText(record.headline, MAX_HEADLINE);
  const outcomes = boundedList(record.outcomes ?? [], MAX_OUTCOMES, MAX_BULLET);
  const openIssues = boundedList(record.openIssues ?? [], MAX_OPEN_ISSUES, MAX_BULLET);
  const nextSteps = boundedList(record.nextSteps ?? [], MAX_NEXT_STEPS, MAX_BULLET);
  if (headline === null || outcomes === null || openIssues === null || nextSteps === null) return null;
  return Object.freeze({
    version: PROJECT_SUMMARY_VERSION,
    projectId,
    headline,
    outcomes,
    openIssues,
    nextSteps,
    source: 'model',
  });
}

/** Renders a summary as the short text a conversation can carry. */
export function renderProjectSummary(document: ProjectSummaryDocument): string {
  const lines = [`项目 ${document.projectId}：${document.headline}`];
  if (document.outcomes.length > 0) {
    lines.push('成果：');
    lines.push(...document.outcomes.map((item) => `- ${item}`));
  }
  if (document.openIssues.length > 0) {
    lines.push('遗留问题：');
    lines.push(...document.openIssues.map((item) => `- ${item}`));
  }
  if (document.nextSteps.length > 0) {
    lines.push('如需继续：');
    lines.push(...document.nextSteps.map((item) => `- ${item}`));
  }
  return lines.join('\n').slice(0, MAX_RENDERED);
}

/** Collects the bounded facts a summarizer is allowed to see. */
export function projectSummaryFacts(
  snapshot: OrganizationSnapshot,
  projectId: string,
  options: {
    readonly purpose?: string;
    readonly reportTexts?: ReadonlyMap<string, string>;
  } = {},
): ProjectSummaryFacts {
  const workers = snapshot.workers
    .filter((worker) => worker.projectId === projectId)
    .map((worker) => Object.freeze({
      id: worker.id,
      displayName: worker.displayName,
      state: worker.state,
    }));
  const reports = snapshot.reports
    .filter((report) => report.projectId === projectId)
    .map((report) => Object.freeze({
      workerId: report.workerId,
      state: report.state,
      body: (options.reportTexts?.get(report.id) ?? '').trim().slice(0, 1_200),
    }));
  return Object.freeze({
    projectId,
    purpose: (options.purpose ?? '').trim().slice(0, 800),
    workers: Object.freeze(workers),
    reports: Object.freeze(reports),
  });
}

/**
 * Deterministic fallback.
 *
 * Convergence must never depend on a provider being reachable: an offline
 * model would otherwise keep a finished project alive forever. This summary is
 * factual and dull by design, and it is what the user sees when the model
 * cannot produce one.
 */
export function deterministicProjectSummary(facts: ProjectSummaryFacts): ProjectSummaryDocument {
  const ready = facts.reports.filter((report) => report.state === 'ready').length;
  const failed = facts.reports.filter((report) => report.state === 'failed' || report.state === 'blocked').length;
  const outcomes = facts.reports
    .filter((report) => report.body.length > 0)
    .slice(-MAX_OUTCOMES)
    .map((report) => {
      const worker = facts.workers.find((item) => item.id === report.workerId);
      return `${worker?.displayName ?? report.workerId}（${report.state}）：${report.body.slice(0, 200)}`;
    });
  return Object.freeze({
    version: PROJECT_SUMMARY_VERSION,
    projectId: facts.projectId,
    headline: `${facts.workers.length} 名员工、${facts.reports.length} 份汇报（成功 ${ready}、失败 ${failed}）。`,
    outcomes: Object.freeze(outcomes),
    openIssues: Object.freeze(failed > 0 ? [`有 ${failed} 份汇报为失败或受阻，详见项目历史。`] : []),
    nextSteps: Object.freeze([]),
    source: 'runtime' as const,
  });
}

const SUMMARY_INSTRUCTIONS = [
  '你是 Conchbase 的项目收尾总结器。',
  '用户的一个项目刚刚结束，你需要把已知事实整理成一份简短、准确、可归档的中文项目报告。',
  '只使用给定事实，不要编造文件、数字、结论或未发生的工作。',
  '不要输出敏感信息、路径、URL 或内部标识之外的推测。',
  'Return only strict JSON with exactly four fields: {"headline":string,"outcomes":string[],"openIssues":string[],"nextSteps":string[]}.',
  'headline 是一句话结论，不超过 120 字。',
  'outcomes 是已经完成并验证的成果，最多 6 条，每条不超过 160 字；没有就返回空数组。',
  'openIssues 是遗留问题或风险，最多 4 条；没有就返回空数组。',
  'nextSteps 是如果用户要继续时可以采取的下一步，最多 3 条；没有就返回空数组。',
  '不要输出 Markdown 代码围栏、解释、前缀或额外字段。',
].join(' ');

export interface ProjectSummaryGeneratorOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * One bounded non-streaming completion that turns facts into a structured
 * summary. Returns null on any failure so the caller can fall back; it never
 * throws into the convergence loop.
 */
export function createOpenAiCompatibleProjectSummaryGenerator(
  options: ProjectSummaryGeneratorOptions,
): (facts: ProjectSummaryFacts) => Promise<ProjectSummaryDocument | null> {
  const base = options.baseUrl.replace(/\/+$/, '');
  const endpoint = `${base}/v1/chat/completions`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Conchbase/1.0.0',
  };
  if (options.appKey) headers.Authorization = `Bearer ${options.appKey}`;

  return async (facts) => {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        body: JSON.stringify({
          model: options.model,
          stream: false,
          messages: [
            { role: 'system', content: SUMMARY_INSTRUCTIONS },
            { role: 'user', content: JSON.stringify(facts) },
          ],
        }),
      });
      if (!response.ok) return null;
      const payload = await response.json() as {
        choices?: readonly { message?: { content?: unknown } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(content));
      } catch {
        return null;
      }
      return parseProjectSummary(facts.projectId, parsed);
    } catch {
      return null;
    }
  };
}

function extractJson(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}
