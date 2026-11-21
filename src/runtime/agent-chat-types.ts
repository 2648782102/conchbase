/**
 * Shared Agent Chat vocabulary.
 *
 * Split out so the state-derivation rules and the service can both refer to the
 * same union without importing each other.
 */

export type AgentChatMessageAuthor = 'user' | 'assistant' | 'runtime';

export type AgentChatMessageState =
  | 'published'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'thinking'
  | 'streaming'
  | 'organizing'
  | 'waiting_approval'
  | 'waiting_attention'
  | 'replied'
  /**
   * The agent finished and the user has not looked at the result yet.
   * Distinct from 'replied' (already seen) and from an idle agent with nothing
   * to report: "done, unread" is the state a task list should surface first.
   */
  | 'done'
  | 'unavailable';

export type AgentChatMessagePhase =
  | 'accepted'
  | 'preparing'
  | 'model'
  | 'organization'
  | 'human'
  | 'terminal';

/**
 * A reasoning effort token, exactly as the model's catalogue publishes it.
 *
 * Deliberately not a closed union. The gateway's own catalogue mixes
 * `none/low/high/max`, `low/medium/high/xhigh/ultra`, a model with only `high`,
 * and models that reason without publishing any level at all. A union of three
 * could not name four of those, so the vocabulary is validated by the
 * catalogue instead — see `src/runtime/reasoning-effort.ts`.
 */
export type AgentChatReasoningEffort = string;

export type AgentChatActivityKind = 'turn' | 'tool' | 'approval' | 'output';
export type AgentChatActivityState = 'running' | 'succeeded' | 'failed' | 'waiting_approval';

export interface AgentChatActivity {
  readonly id: string;
  readonly kind: AgentChatActivityKind;
  readonly label: string;
  readonly state: AgentChatActivityState;
  readonly detail: string | null;
}

export interface AgentChatMessage {
  readonly id: string;
  readonly sequence: number;
  readonly author: AgentChatMessageAuthor;
  readonly body: string;
  readonly state: AgentChatMessageState;
  readonly taskId: string | null;
  readonly error: string | null;
  readonly phase: AgentChatMessagePhase;
  readonly progress: number | null;
  readonly updatedAt: string;
  readonly replyToId: string | null;
  readonly activity: readonly AgentChatActivity[];
}
