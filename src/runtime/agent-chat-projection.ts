import type { AgentChatMessage } from './agent-chat-types.js';
import {
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

  if (!task) {
    if (message.state === 'failed' && message.error === 'Task not found.') return null;
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
  const next = Object.freeze({
    ...message,
    body: state === 'done' || state === 'replied'
      ? boundedOutput(task.output)
        : state === 'failed'
          ? failureBody(error)
        : '回复已取消。',
    state: finalState,
    phase: 'terminal' as const,
    progress: state === 'done' || state === 'replied' ? 100 : null,
    error,
    updatedAt: message.updatedAt,
    activity: Object.freeze([...activity]),
  });
  /*
   * A terminal message may still need to change.
   *
   * The message is the presentation of a task, and a task can be retried: it
   * moves from `interrupted` back through `queued` to `succeeded`, while the
   * message stays `failed` because the old rule never re-projected a terminal
   * one. The reader then saw a failure forever.
   *
   * Re-projecting is safe only if it is idempotent, so `null` is returned when
   * nothing but `updatedAt` would change. `updatedAt` is preserved instead of
   * being bumped, which is what keeps a repeated read from writing every time.
   */
  if (message.state === next.state
    && message.body === next.body
    && message.error === next.error
    && message.phase === next.phase
    && message.progress === next.progress
    && JSON.stringify(message.activity) === JSON.stringify(next.activity)) {
    return null;
  }
  return Object.freeze({ ...next, updatedAt: now });
}

/**
 * Turns a bounded task error into something a reader can act on.
 *
 * "模型调用失败" was shown for every failure, including a tool the Runtime
 * refused and one the operator rejected. A reader cannot tell a bad key from a
 * blocked URL from a refused approval, so the message hid the one fact they
 * needed. The task already stores the reason; this only decides how to phrase
 * it.
 */
function failureBody(error: string | null): string {
  if (error === null || error.trim().length === 0) return '模型调用失败。';
  if (/rejected by the operator/i.test(error)) return '你拒绝了这次工具执行，本轮已停止。';
  /*
   * A tool rejection reaches the task as its code or message. Surfacing it is
   * safe — tool errors are already bounded and never contain arguments — and it
   * is the difference between "something broke" and "the URL was blocked".
   */
  /*
   * Match both the code and the human message. A tool rejection reaches the task
   * as its message text when the message was supplied, so keying only on codes
   * left the common case falling through to "model call failed".
   */
  if (/private_network_blocked|unsupported_scheme|url_contains_credentials|unsupported_content_type|too_many_redirects|private, loopback, or link-local|only http and https|credentials/i.test(error)) {
    return `这次网络请求被运行时拒绝：${error.slice(0, 160)}`;
  }
  if (/path_escapes_root|refuses_workspace_root|recursive_requires_confirmation|target_exists|parent_not_found|inside the workspace/i.test(error)) {
    return `这次文件操作被运行时拒绝：${error.slice(0, 160)}`;
  }
  return `模型调用失败：${error.slice(0, 160)}`;
}
