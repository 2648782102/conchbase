import type { AgentChatMessage } from './agent-chat-types.js';
import {
  nonterminalMessageState,
  phaseForState,
  taskStateToMessageState,
  terminalTaskState,
  unavailableError,
} from './agent-chat-state.js';
import type { TaskSnapshot } from './task-store.js';
import type { AgentChatActivity } from './agent-chat-types.js';
import { boundedOutput } from './agent-chat-output.js';

/**
 * Projection of task state onto conversation messages.
 *
 * The same rule set is used in two places with different consequences:
 *
 *  - the **write** path persists the projection when a task changes, so the
 *    conversation record is authoritative rather than being recomputed per read;
 *  - the **read** path projects without persisting, so a query never mutates
 *    state.
 *
 * Keeping one implementation means the two cannot drift. Before this split the
 * only implementation both computed and persisted, which made every read a
 * write and left three writers (Boss, task, chat) able to touch one record.
 */
export interface ProjectionInput {
  readonly message: AgentChatMessage;
  readonly task: TaskSnapshot | null;
  readonly activity: readonly AgentChatActivity[];
  readonly now: string;
}


/**
 * Returns the projected message, or `null` when nothing changed.
 *
 * `null` is meaningful: callers use it to skip a write and to skip re-rendering
 * an unchanged frame.
 */
export function projectMessage(input: ProjectionInput): AgentChatMessage | null {
  const { message, task, activity, now } = input;
  if (message.author !== 'assistant' || message.taskId === null) return null;
  if (!nonterminalMessageState(message.state)) return null;

  if (!task) {
    return Object.freeze({
      ...message,
      body: 'Agent 任务不可用。',
      state: 'failed' as const,
      error: 'Task not found.',
      updatedAt: now,
    });
  }

  if (!terminalTaskState(task.state)) {
    const state = taskStateToMessageState(task);
    if (task.partialOutput && task.partialOutput.length > 0) {
      const body = boundedOutput(task.partialOutput);
      const progress = Math.min(100, Math.max(5, task.partialOutput.length));
      const activityChanged = JSON.stringify(message.activity) !== JSON.stringify(activity);
      if (message.body === body && message.state === state && message.progress === progress
        && !activityChanged) {
        return null;
      }
      return Object.freeze({
        ...message,
        body,
        state,
        phase: 'model' as const,
        progress,
        updatedAt: now,
        activity: Object.freeze([...activity]),
      });
    }
    if (message.state === state && JSON.stringify(message.activity) === JSON.stringify(activity)) {
      return null;
    }
    return Object.freeze({
      ...message,
      state,
      phase: phaseForState(state),
      updatedAt: now,
      activity: Object.freeze([...activity]),
    });
  }

  // Terminal: the projection is the authoritative record of the outcome, but
  // "already read" is a fact about this message, not the task. A task that
  // succeeded maps to `done`; if the message was already marked read, keep the
  // `replied` it carries so reading once is not undone by every projection.
  const projected = taskStateToMessageState(task);
  const state = projected === 'done' && message.state === 'replied' ? 'replied' : projected;
  const error = state === 'failed' ? (task.error ?? 'Agent task failed.').slice(0, 500) : null;
  const finalState = state === 'failed' && unavailableError(error) ? 'unavailable' : state;
  return Object.freeze({
    ...message,
    body: state === 'done' || state === 'replied'
      ? boundedOutput(task.output)
      : state === 'failed'
        ? /rejected by the operator/i.test(error ?? '')
          ? '你拒绝了这次工具执行，本轮已停止。'
          : '模型调用失败。'
        : '回复已取消。',
    state: finalState,
    phase: 'terminal' as const,
    progress: state === 'done' || state === 'replied' ? 100 : null,
    error,
    updatedAt: now,
    activity: Object.freeze([...activity]),
  });
}
