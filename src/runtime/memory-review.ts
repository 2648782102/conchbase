import type { AgentMemoryInput } from './agent-memory.js';
import { containsSecretLike } from './secret-filter.js';

export const MEMORY_REVIEW_VERSION = 1;

/**
 * The reviewer's verdict on one proposed memory.
 *
 * It is a recommendation, not an authority: the Runtime still owns shape,
 * scope, target existence, and persistence. A reviewer that says "accept"
 * cannot widen a scope or grant a capability, and one that says "reject" cannot
 * delete a fact the Runtime derived itself.
 */
export interface MemoryReviewDecision {
  readonly index: number;
  readonly verdict: 'accept' | 'reject';
  readonly reason: string;
}

export interface MemoryReviewResult {
  readonly version: typeof MEMORY_REVIEW_VERSION;
  readonly decisions: readonly MemoryReviewDecision[];
}

export interface MemoryReviewInput {
  readonly userText: string;
  readonly assistantReply: string;
  /** Bounded existing memory titles, for conflict detection. */
  readonly existingTitles: readonly string[];
  readonly proposals: readonly AgentMemoryInput[];
}

const MAX_REASON = 200;

/**
 * Builds the reviewer prompt.
 *
 * The reviewer is asked one question only: is this a durable preference the
 * user intended to keep, or a one-turn instruction? That is the judgement the
 * Runtime cannot make with rules, and the reason a separate reviewer exists at
 * all. Everything else stays with the Runtime so the reviewer's blast radius
 * stays small.
 */
export function memoryReviewInstructions(): string {
  return [
    '你是 Conchbase 的记忆审核员，只做一件事：判断候选记忆是否值得长期保留。',
    '候选记忆来自老板 Agent 的提议。老板容易把“这一次的要求”误当作“以后都要这样”。',
    '只有满足以下全部条件才 accept：',
    '1. 用户表达了跨轮次仍然成立的偏好、约定或事实，而不是只针对本轮回复的格式要求；',
    '2. 内容具体、可执行，不是对当次任务结果的复述；',
    '3. 不与已有记忆明显重复或冲突；',
    '4. 不包含密钥、令牌、密码、私有路径或与业务无关的个人隐私。',
    '若无法确定用户意图是持久偏好，返回 reject 并给出简短理由。宁可漏记，不可错记。',
    'Return only strict JSON: {"decisions":[{"index":number,"verdict":"accept"|"reject","reason":string}]}.',
    'decisions 必须覆盖每个候选的 index，且 reason 不超过 120 字。',
  ].join(' ');
}

/** Validates a reviewer response against the proposals it was asked about. */
export function parseMemoryReviewResult(
  value: unknown,
  proposalCount: number,
): MemoryReviewResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'decisions');
  if (unknown.length > 0) return null;
  const raw = record.decisions;
  if (!Array.isArray(raw) || raw.length !== proposalCount) return null;
  const decisions: MemoryReviewDecision[] = [];
  const seen = new Set<number>();
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
    const entry = candidate as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !['index', 'verdict', 'reason'].includes(key))) return null;
    const index = entry.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= proposalCount) return null;
    if (seen.has(index)) return null;
    seen.add(index);
    if (entry.verdict !== 'accept' && entry.verdict !== 'reject') return null;
    if (typeof entry.reason !== 'string') return null;
    const reason = entry.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_REASON);
    if (containsSecretLike(reason)) return null;
    decisions.push(Object.freeze({ index, verdict: entry.verdict, reason }));
  }
  if (seen.size !== proposalCount) return null;
  return Object.freeze({
    version: MEMORY_REVIEW_VERSION,
    decisions: Object.freeze(decisions.sort((left, right) => left.index - right.index)),
  });
}

export interface MemoryReviewerOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * One bounded review call.
 *
 * Returns null on any failure. A reviewer outage must not block a conversation,
 * so the caller decides the fallback policy; this function never throws.
 */
export function createOpenAiCompatibleMemoryReviewer(
  options: MemoryReviewerOptions,
): (input: MemoryReviewInput) => Promise<MemoryReviewResult | null> {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Conchbase/1.0.0',
  };
  if (options.appKey) headers.Authorization = `Bearer ${options.appKey}`;

  return async (input) => {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        body: JSON.stringify({
          model: options.model,
          stream: false,
          messages: [
            { role: 'system', content: memoryReviewInstructions() },
            {
              role: 'user',
              content: JSON.stringify({
                userText: input.userText.slice(0, 4_000),
                assistantReply: input.assistantReply.slice(0, 2_000),
                existingTitles: input.existingTitles.slice(0, 24),
                proposals: input.proposals,
              }),
            },
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
      return parseMemoryReviewResult(parsed, input.proposals.length);
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
