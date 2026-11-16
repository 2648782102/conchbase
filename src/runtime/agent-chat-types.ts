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

export type AgentChatReasoningEffort = 'low' | 'medium' | 'high';

export type AgentChatActivityKind = 'turn' | 'tool' | 'approval' | 'output';
export type AgentChatActivityState = 'running' | 'succeeded' | 'failed' | 'waiting_approval';
