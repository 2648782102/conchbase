/**
 * Memory for a direct Agent conversation.
 *
 * Memory existed, but only the Boss used it: a person could talk to their
 * configured Agent for ten turns and it would remember nothing about them. The
 * store, the scopes, the reviewer, and the index renderer were all already
 * there — nothing connected them to `AgentChatService`.
 *
 * Three rules carry over from the Boss implementation, because they are about
 * safety rather than about the Boss:
 *
 * 1. Memory is advisory. It is rendered into the prompt as recollection and can
 *    never grant a tool, widen a boundary, or change policy.
 * 2. A proposal is a proposal. The Runtime checks scope and target; a reviewer
 *    may only narrow the set further. A configured-but-failing reviewer writes
 *    nothing.
 * 3. A retracted fact stays retracted. `AgentMemoryStore.write` refuses to
 *    restore one from an automatic write, and that check lives in the store, not
 *    here, so no caller can route around it.
 */
import {
  MEMORY_LIMITS,
  renderMemoryIndex,
  type AgentMemoryInput,
  type AgentMemoryStore,
} from './agent-memory.js';
import type { MemoryReviewInput, MemoryReviewResult } from './memory-review.js';
import { containsSecretLike } from './secret-filter.js';
import { AgentMemoryValidationError, parseAgentMemoryInput } from './agent-memory.js';

export type AgentChatMemoryReviewer = (input: MemoryReviewInput) => Promise<MemoryReviewResult | null>;

export interface AgentChatMemoryOptions {
  readonly memory?: AgentMemoryStore;
  readonly reviewer?: AgentChatMemoryReviewer;
}

export class AgentChatMemory {
  private readonly memory: AgentMemoryStore | undefined;
  private readonly reviewer: AgentChatMemoryReviewer | undefined;

  constructor(options: AgentChatMemoryOptions = {}) {
    this.memory = options.memory;
    this.reviewer = options.reviewer;
  }

  /**
   * The compact index for one Agent: its own facts plus runtime-wide ones.
   *
   * Never throws. Memory is an enhancement, and a store problem must not turn a
   * conversation into an error page.
   */
  index(agentId: string): string {
    const memory = this.memory;
    if (!memory) return '';
    try {
      const entries = [
        ...memory.list({ scope: 'agent', scopeId: agentId, limit: MEMORY_LIMITS.injected }),
        ...memory.list({ scope: 'runtime', limit: 4 }),
      ];
      return renderMemoryIndex(entries);
    } catch {
      return '';
    }
  }

  /**
   * Persists what the model proposed, after the Runtime has checked it.
   *
   * Only `agent` scope is accepted here. A direct conversation has no authority
   * over runtime-wide facts or other Agents' scopes, so a proposal naming them
   * is dropped rather than reinterpreted — silently rewriting the scope would
   * put a fact somewhere the user never agreed to.
   */
  async recordProposals(
    entries: readonly AgentMemoryInput[],
    context: {
      readonly agentId: string;
      readonly userText: string;
      readonly assistantReply: string;
      readonly sourceIntentId: string;
    },
  ): Promise<readonly AgentMemoryInput[]> {
    const memory = this.memory;
    if (!memory) return Object.freeze([]);
    const candidates = entries.filter((entry) => entry.scope === 'agent' && entry.scopeId === context.agentId);
    if (candidates.length === 0) return Object.freeze([]);

    let accepted: readonly AgentMemoryInput[] = candidates;
    if (this.reviewer) {
      let review: MemoryReviewResult | null = null;
      try {
        review = await this.reviewer({
          userText: context.userText,
          assistantReply: context.assistantReply,
          existingTitles: [...new Set(memory.list({
            scope: 'agent',
            scopeId: context.agentId,
            limit: 24,
          }).map((stored) => stored.title))],
          proposals: candidates,
        });
      } catch {
        review = null;
      }
      if (!review) return Object.freeze([]);
      const verdicts = new Map(review.decisions.map((decision) => [decision.index, decision]));
      accepted = candidates.filter((_entry, index) => verdicts.get(index)?.verdict === 'accept');
    }

    const written: AgentMemoryInput[] = [];
    for (const entry of accepted) {
      try {
        memory.write({
          ...entry,
          origin: 'conversational',
          ...(entry.sourceIntentId === undefined ? { sourceIntentId: context.sourceIntentId } : {}),
        });
        written.push(entry);
      } catch {
        // A rejected proposal is not a conversation failure: the reply already
        // told the user what it did, and the store refused a duplicate, an
        // oversized body, or a retracted key.
      }
    }
    return Object.freeze(written);
  }
}

/**
 * Asks a model whether the exchange contains a fact worth keeping.
 *
 * This is a separate, bounded call rather than a field in the reply, because a
 * reply must stay a reply: teaching the main turn to emit a second JSON document
 * would make every conversation a parsing problem, and a model failure there
 * would cost the user their answer.
 *
 * It is also deliberately allowed to say "nothing". Most turns are not worth
 * remembering, and a proposer that always proposes is how a memory store fills
 * with noise the reviewer then has to reject.
 */
export interface MemoryProposalOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export type MemoryProposer = (input: {
  readonly agentId: string;
  readonly agentName: string;
  readonly userText: string;
  readonly assistantReply: string;
  readonly existingTitles: readonly string[];
}) => Promise<readonly AgentMemoryInput[]>;

export function memoryProposalInstructions(): string {
  return [
    '你是 Conchbase 的记忆提议器。判断这轮对话里是否出现了值得长期记住的内容。',
    '只提议同时满足全部条件的内容：',
    '1. 跨轮次仍然成立的偏好、约定、决策或事实，而不是本轮的一次性要求；',
    '2. 用户明确表达或明确同意过；',
    '3. 不与已有记忆重复；',
    '4. 不含密钥、令牌、密码或私有路径。',
    '如果一个都不满足，返回空数组。大多数对话都应该返回空数组。',
    '每条提议的 scope 固定为 "agent"，scopeId 必须等于给定的 agentId。',
    'type 只能是 preference、project-fact、instruction、decision、temporary 之一。',
    'Return only strict JSON: {"memories":[{"type":string,"key":string,"title":string,"body":string,"scope":"agent","scopeId":string}]}.',
  ].join(' ');
}

export function createOpenAiCompatibleMemoryProposer(
  options: MemoryProposalOptions,
): MemoryProposer {
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
            { role: 'system', content: memoryProposalInstructions() },
            {
              role: 'user',
              content: JSON.stringify({
                agentId: input.agentId,
                agentName: input.agentName,
                userText: input.userText.slice(0, 4_000),
                assistantReply: input.assistantReply.slice(0, 2_000),
                existingTitles: input.existingTitles.slice(0, 24),
              }),
            },
          ],
        }),
      });
      if (!response.ok) return Object.freeze([]);
      const payload = await response.json() as {
        choices?: readonly { message?: { content?: unknown } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) return Object.freeze([]);
      return parseMemoryProposals(content, input.agentId);
    } catch {
      return Object.freeze([]);
    }
  };
}

/**
 * Validates a proposer response.
 *
 * Everything here is untrusted. A proposal that names another Agent's scope, or
 * carries a secret, is dropped rather than repaired: silently rewriting the
 * scope would store a fact where the user never put it.
 */
export function parseMemoryProposals(content: string, agentId: string): readonly AgentMemoryInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    return Object.freeze([]);
  }
  const memories = (parsed as { memories?: unknown })?.memories;
  if (!Array.isArray(memories)) return Object.freeze([]);
  const accepted: AgentMemoryInput[] = [];
  for (const candidate of memories.slice(0, 8)) {
    try {
      const input = parseAgentMemoryInput(candidate);
      if (input.scope !== 'agent' || input.scopeId !== agentId) continue;
      if (containsSecretLike(input.title) || containsSecretLike(input.body)) continue;
      accepted.push(input);
    } catch (cause) {
      if (cause instanceof AgentMemoryValidationError) continue;
      throw cause;
    }
  }
  return Object.freeze(accepted);
}

/** Extracts the first JSON object from a model reply that may carry prose. */
export function extractJson(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  return start >= 0 && end > start ? content.slice(start, end + 1) : content;
}
