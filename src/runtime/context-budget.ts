/**
 * Keeps a prompt inside a model's context window.
 *
 * Before this module the Runtime built a prompt and sent it. A long
 * conversation, or a loop that appended tool results, eventually exceeded the
 * window and the provider rejected the turn — which reached the user as
 * "model failed" after the work had already been done. Nothing bounded the
 * prompt, because nothing measured it.
 *
 * Three decisions shape the implementation:
 *
 * 1. **Estimate, do not tokenize.** A real tokenizer per provider would be a
 *    dependency and a divergence risk. The estimate is deliberately
 *    pessimistic: CJK is counted at one token per character (roughly true for
 *    every current tokenizer and worse than latin), everything else at one per
 *    four characters. Under-counting spends the user's turn; over-counting
 *    spends a few tokens of their window.
 * 2. **Reserve output.** A prompt that exactly fills the window leaves no room
 *    for the reply. The reserve is a fraction of the window, not a constant,
 *    because the same answer is a rounding error in a 1M window and half of a
 *    small one.
 * 3. **Never drop the instructions.** System turns carry the Agent's
 *    instructions, the tool list, and Skill guidance. Dropping them to fit a
 *    window would silently change what the Agent is, so they are kept and the
 *    conversation is cut instead. If the system turns alone do not fit, that is
 *    a configuration error and is reported as one.
 */
import type { ProviderMessage } from './model-adapter.js';

/** Characters per token for non-CJK text. Deliberately conservative. */
const CHARS_PER_TOKEN = 4;

/** Share of the window held back for the reply. */
const OUTPUT_RESERVE_RATIO = 0.2;
const MIN_OUTPUT_RESERVE = 512;

/**
 * The window assumed when a model does not publish one.
 *
 * Small enough to be safe on the smallest likely model, large enough that a
 * normal conversation is untouched. A model that publishes its window always
 * wins over this.
 */
export const DEFAULT_CONTEXT_TOKENS = 32_000;

export interface ContextBudget {
  /** The model's total window, or the conservative default. */
  readonly totalTokens: number;
  /** Held back so a reply can be produced. */
  readonly outputReserve: number;
  /** What the prompt may consume. */
  readonly promptTokens: number;
}

export function contextBudget(totalTokens: number | undefined): ContextBudget {
  const total = Number.isFinite(totalTokens) && (totalTokens ?? 0) > 0
    ? Math.trunc(totalTokens as number)
    : DEFAULT_CONTEXT_TOKENS;
  const reserve = Math.min(
    Math.max(MIN_OUTPUT_RESERVE, Math.ceil(total * OUTPUT_RESERVE_RATIO)),
    Math.max(MIN_OUTPUT_RESERVE, Math.floor(total / 2)),
  );
  return Object.freeze({
    totalTokens: total,
    outputReserve: reserve,
    promptTokens: Math.max(1, total - reserve),
  });
}

/**
 * Estimated tokens for one string.
 *
 * CJK ranges are counted one per character. The ranges cover the CJK Unified
 * Ideographs, the Extension A block, Hiragana/Katakana, and Hangul: between
 * them they catch essentially every message this Runtime receives in Chinese,
 * Japanese, or Korean.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff)   // Hiragana, Katakana
      || (code >= 0x3400 && code <= 0x4dbf) // CJK Extension A
      || (code >= 0x4e00 && code <= 0x9fff) // CJK Unified Ideographs
      || (code >= 0xac00 && code <= 0xd7af) // Hangul syllables
      || (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
      || (code >= 0x20000 && code <= 0x2fa1f) // CJK Extensions B–F
    ) {
      cjk += 1;
    }
  }
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: ProviderMessage): number {
  // Fixed per-message overhead: role markers, separators, and the wrapper every
  // chat template adds. Small, but a loop with 100 messages adds up.
  let overhead = 4;
  if (message.role === 'assistant' && message.toolCalls) {
    overhead += message.toolCalls.length * 8;
    for (const call of message.toolCalls) {
      overhead += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments));
    }
  }
  return overhead + estimateTokens(message.content);
}

export function estimatePromptTokens(messages: readonly ProviderMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export type PromptFit =
  | { readonly kind: 'fits'; readonly tokens: number; readonly budget: ContextBudget }
  | {
    readonly kind: 'trimmed';
    readonly tokens: number;
    readonly budget: ContextBudget;
    readonly droppedMessages: number;
    readonly droppedTokens: number;
  }
  | {
    readonly kind: 'overflow';
    readonly budget: ContextBudget;
    /** Why it cannot be trimmed: the instructions alone exceed the budget. */
    readonly systemTokens: number;
  };

/**
 * Trims a prompt to its budget, dropping the oldest conversation first.
 *
 * The kept tail always starts at a `user` turn when one is available: a model
 * that opens on an assistant answer, or on a tool result whose call it cannot
 * see, has to guess what it replied to. Tool results are dropped together with
 * the assistant turn that requested them, for the same reason — a `tool` message
 * with no preceding `toolCalls` is a protocol error in every chat template.
 */
export function fitPrompt(
  messages: readonly ProviderMessage[],
  budget: ContextBudget,
): { readonly messages: readonly ProviderMessage[]; readonly fit: PromptFit } {
  const total = estimatePromptTokens(messages);
  if (total <= budget.promptTokens) {
    return { messages, fit: { kind: 'fits', tokens: total, budget } };
  }

  const system = messages.filter((message) => message.role === 'system');
  const systemTokens = estimatePromptTokens(system);
  if (systemTokens >= budget.promptTokens) {
    return { messages, fit: { kind: 'overflow', budget, systemTokens } };
  }

  const conversation = messages.filter((message) => message.role !== 'system');
  let kept = conversation.length;
  let keptTokens = systemTokens + estimatePromptTokens(conversation);

  while (kept > 0 && keptTokens > budget.promptTokens) {
    kept -= 1;
    keptTokens -= estimateMessageTokens(conversation[kept]!);
  }

  const tail = conversation.slice(conversation.length - kept);
  const repaired = dropDanglingToolResults(tail);
  const aligned = alignToUserTurn(repaired);
  const finalTokens = systemTokens + estimatePromptTokens(aligned);

  return {
    messages: Object.freeze([...system, ...aligned]),
    fit: {
      kind: 'trimmed',
      tokens: finalTokens,
      budget,
      droppedMessages: messages.length - system.length - aligned.length,
      droppedTokens: Math.max(0, total - finalTokens),
    },
  };
}

/**
 * Removes tool results whose requesting assistant turn was trimmed away.
 *
 * A chat template rejects a `tool` message that no `toolCalls` introduced, so
 * trimming the middle of an exchange has to trim both halves.
 */
function dropDanglingToolResults(messages: readonly ProviderMessage[]): readonly ProviderMessage[] {
  const known = new Set<string>();
  const result: ProviderMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) known.add(call.id);
      result.push(message);
      continue;
    }
    if (message.role === 'tool') {
      if (!known.has(message.toolCallId)) continue;
      result.push(message);
      continue;
    }
    result.push(message);
  }
  return result;
}

/**
 * Starts the kept conversation at a user turn.
 *
 * Leading assistant answers and orphaned tool results are dropped. If no user
 * turn remains the list is returned as is: a tool-only tail is still legal, and
 * dropping it entirely would leave the model with instructions and no task.
 */
function alignToUserTurn(messages: readonly ProviderMessage[]): readonly ProviderMessage[] {
  const firstUser = messages.findIndex((message) => message.role === 'user');
  return firstUser > 0 ? messages.slice(firstUser) : messages;
}

/** A short, user-facing sentence describing what was done to fit the window. */
export function describeFit(fit: PromptFit): string | null {
  if (fit.kind === 'fits') return null;
  if (fit.kind === 'overflow') {
    return `指令与技能说明本身已超出模型的上下文预算（约 ${fit.systemTokens} tokens / 上限 ${fit.budget.promptTokens}），请缩短 Agent 指令或改用更大上下文的模型。`;
  }
  return `为适配模型上下文，已省略较早的 ${fit.droppedMessages} 条消息（约 ${fit.droppedTokens} tokens）。`;
}
