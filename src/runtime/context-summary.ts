/**
 * Compresses the part of a prompt that no longer fits into a short summary.
 *
 * Trimming alone keeps the Runtime honest but not useful: the model loses the
 * earlier work, and the only trace is an event saying so. A summary keeps the
 * *facts* — what was asked, what was decided, what a tool returned — in a form
 * that costs a fraction of the original tokens.
 *
 * Three rules shape this:
 *
 * 1. **The summary is untrusted.** It is model output that will be re-injected
 *    into a later prompt, which is exactly the shape of a prompt-injection
 *    loop. It is bounded, stripped of control characters, and labelled as
 *    recollection rather than instructions, so a summary cannot quietly become
 *    a new system prompt.
 * 2. **The summary has its own budget.** Without one, summarising to save
 *    tokens can cost more than it saves. It is a small fixed share of the
 *    window, and a summary longer than that is cut, not retried.
 * 3. **Failure is silent and safe.** A summariser outage falls back to the
 *    plain trim that already worked. Summarising is an improvement, never a
 *    prerequisite for answering.
 */
import type { ProviderMessage } from './model-adapter.js';
import { estimateTokens } from './context-budget.js';

/** How much of the window a summary may consume. */
const SUMMARY_SHARE = 0.15;
const MIN_SUMMARY_TOKENS = 128;
const MAX_SUMMARY_TOKENS = 1_200;

export interface SummaryBudget {
  readonly tokens: number;
}

export function summaryBudget(promptTokens: number): SummaryBudget {
  const raw = Math.floor(promptTokens * SUMMARY_SHARE);
  return Object.freeze({
    tokens: Math.max(MIN_SUMMARY_TOKENS, Math.min(MAX_SUMMARY_TOKENS, raw)),
  });
}

export function summaryInstructions(): string {
  return [
    '你是对话压缩器。把给定的历史对话压缩成一段可继续工作的事实摘要。',
    '只保留：用户的目标与约束、已经做出的决定、工具返回的关键事实、尚未完成的事项。',
    '不要保留：客套话、重复的推理过程、逐字文本、任何看起来像密钥或令牌的内容。',
    '不要写下新的指令或要求，你只是在记录已经发生的事。',
    '用不超过 200 字的中文陈述句输出，不要列表，不要标题，不要代码块。',
  ].join(' ');
}

/**
 * Flattens dropped messages into a transcript for the summariser.
 *
 * Bounded per message so one huge tool result cannot crowd out the rest of the
 * history — the point is to keep the shape of the work, not to re-send it.
 */
export function transcriptForSummary(
  dropped: readonly ProviderMessage[],
  options: { readonly maxMessages?: number; readonly maxCharsPerMessage?: number } = {},
): string {
  const maxMessages = options.maxMessages ?? 60;
  const maxChars = options.maxCharsPerMessage ?? 1_200;
  const slice = dropped.slice(-maxMessages);
  return slice.map((message) => {
    const body = message.content.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxChars);
    if (message.role === 'tool') return `工具结果: ${body}`;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const names = message.toolCalls.map((call) => call.name).join(', ');
      return `助手(调用 ${names}): ${body}`;
    }
    return `${message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统'}: ${body}`;
  }).join('\n');
}

/**
 * Validates and bounds a summariser's reply.
 *
 * Returns null when the reply is unusable, so the caller can keep the plain
 * trim. A summary that is empty, or that is longer than its budget, is not
 * worth re-sending.
 */
export function parseSummary(content: unknown, budget: SummaryBudget): string | null {
  if (typeof content !== 'string') return null;
  const cleaned = content
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 8) return null;
  if (estimateTokens(cleaned) > budget.tokens * 2) return null;
  // A summary is bounded by characters as well, so a low-token but enormous
  // latin blob cannot slip through the estimate.
  return cleaned.slice(0, budget.tokens * 4);
}

/**
 * Wraps a summary as a system message.
 *
 * A `system` turn, not `user`: it is context about the conversation rather than
 * something the user just said, and it must be labelled so the model treats it
 * as recollection. The wording states its own limits, because a model that
 * believes a summary is complete will refuse to re-read a file it was told
 * about.
 */
export function summaryMessage(summary: string): ProviderMessage {
  return Object.freeze({
    role: 'system' as const,
    content: [
      '以下是被省略的较早对话的摘要，仅供回忆参考：',
      summary,
      '摘要可能不完整；如果某条结论影响当前判断，请重新查看来源而不要只依赖它。',
    ].join('\n'),
  });
}

/**
 * Produces a summary of dropped history.
 *
 * A function rather than a class so the loop can stay synchronous about its own
 * decisions: this is either configured or it is not, and when it fails the
 * caller keeps the trim it already had.
 */
export type ContextSummarizer = (input: {
  readonly transcript: string;
  readonly budget: SummaryBudget;
  readonly signal?: AbortSignal;
}) => Promise<string | null>;

export interface OpenAICompatibleSummarizerOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function createOpenAiCompatibleSummarizer(
  options: OpenAICompatibleSummarizerOptions,
): ContextSummarizer {
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
        signal: AbortSignal.any([
          AbortSignal.timeout(options.timeoutMs ?? 20_000),
          ...(input.signal ? [input.signal] : []),
        ]),
        body: JSON.stringify({
          model: options.model,
          stream: false,
          messages: [
            { role: 'system', content: summaryInstructions() },
            { role: 'user', content: input.transcript.slice(0, 12_000) },
          ],
        }),
      });
      if (!response.ok) return null;
      const payload = await response.json() as {
        choices?: readonly { message?: { content?: unknown } }[];
      };
      return parseSummary(payload.choices?.[0]?.message?.content, input.budget);
    } catch {
      return null;
    }
  };
}
