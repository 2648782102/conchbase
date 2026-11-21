import type { TaskSnapshot } from './task-store.js';
import type {
  AgentChatMessagePhase,
  AgentChatMessageState,
  AgentChatReasoningEffort,
} from './agent-chat-types.js';
import { parseEffortToken } from './reasoning-effort.js';

/**
 * State derivation for Agent Chat messages.
 *
 * The mapping from a task's state to what the user sees is a pure function with
 * more rules than it looks: `done` versus `replied`, `unavailable` versus
 * `failed`, and which phase a state belongs to. Those rules previously lived
 * inline among the service's I/O and could only be exercised through a full
 * turn.
 *
 * Types live in `agent-chat-types.ts` so this module and the service can share
 * them without an import cycle.
 */

export const NONTERMINAL_STATES: readonly AgentChatMessageState[] = Object.freeze([
  'pending', 'thinking', 'streaming', 'organizing', 'waiting_approval',
]);

export function terminalTaskState(state: TaskSnapshot['state']): boolean {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
}

export function nonterminalMessageState(state: AgentChatMessageState): boolean {
  return NONTERMINAL_STATES.includes(state);
}

/**
 * Whether the message has reached a state nothing will advance again.
 *
 * Not the same set as `NONTERMINAL_STATES`: `waiting_attention` is a human wait
 * that a later projection may still replace, while `done` and `replied` are the
 * two views of one finished reply.
 */
export function terminalMessageState(state: AgentChatMessageState): boolean {
  return !NONTERMINAL_STATES.includes(state) && state !== 'waiting_attention';
}

export function taskStateToMessageState(task: TaskSnapshot): AgentChatMessageState {
  // A finished task is `done` (unread) until the user reads the conversation.
  // Returning `replied` here would skip the distinction entirely.
  if (task.state === 'succeeded') return 'done';
  if (task.state === 'failed' || task.state === 'interrupted') return 'failed';
  if (task.state === 'cancelled') return 'cancelled';
  if (task.state === 'waiting_approval') return 'waiting_approval';
  return task.partialOutput && task.partialOutput.length > 0 ? 'streaming' : 'thinking';
}

export function unavailableError(message: string | null): boolean {
  return /model catalog is unavailable|provider model catalog is unavailable|upstream|not valid JSON|empty completion|invalid JSON|not bounded|unknown fields|secret-like|selected model is not available/i.test(message ?? '');
}

export function unavailableBody(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : '';
  if (/HTTP 429|rate limit/i.test(text)) return '模型服务当前请求过多，请稍后重试。';
  if (/HTTP 5\d\d|upstream/i.test(text)) return '模型服务暂不可用，请检查 Magpie 配置或稍后重试。';
  if (/not valid JSON|invalid JSON|not bounded|unknown fields|empty completion/i.test(text)) {
    return '模型返回格式不符合 Runtime 契约，本次回复未采用。';
  }
  if (/secret-like/i.test(text)) return '模型返回包含敏感内容，本次回复已拒绝。';
  return '模型目录暂不可用，请检查 Magpie 配置。';
}

export function phaseForState(state: AgentChatMessageState): AgentChatMessagePhase {
  if (state === 'thinking' || state === 'streaming' || state === 'pending') return 'preparing';
  if (state === 'organizing') return 'organization';
  if (state === 'waiting_attention' || state === 'waiting_approval') return 'human';
  if (state === 'replied' || state === 'done' || state === 'failed' || state === 'cancelled'
    || state === 'unavailable' || state === 'succeeded') return 'terminal';
  return 'accepted';
}

/**
 * Read the effort a caller asked for, or `undefined` when they did not say.
 *
 * There is no default here any more. The old one — "medium" — was a guess that
 * reached a model the gateway describes as `none/low/high/max`: it accepted
 * `medium` by ignoring it, so every turn silently ran at the gateway's default
 * while the client showed a choice that had never been applied.
 */
export function parseReasoningEffort(value: unknown): AgentChatReasoningEffort | undefined {
  return parseEffortToken(value);
}
