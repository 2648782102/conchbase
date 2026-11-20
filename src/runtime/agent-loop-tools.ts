import type { ProviderMessage, ProviderToolCall } from './model-adapter.js';
import type { ReadResultCache } from './read-result-cache.js';
import { ToolRejectedError } from './tool-provider.js';
import { digestArguments } from './tool-arguments.js';
import type { TaskCapabilities } from './task-capabilities.js';
import type { TaskSnapshot, TaskStore } from './task-store.js';

/**
 * Draining one turn's tool calls.
 *
 * This was the densest part of the task service: approval checkpoints, read
 * reuse, event recording, and message accumulation interleaved inside a loop
 * that also owned task state. Extracted behind an explicit context so the
 * dependencies are visible, and so the ordering rules below can be read in one
 * place.
 *
 * Ordering is the contract:
 *  1. an unknown tool is recorded as a failure, never executed;
 *  2. a consequential tool pauses the task before it runs, and an identical
 *     write that already succeeded is refused rather than repeated;
 *  3. an identical read in the same attempt is reused instead of re-executed;
 *  4. every outcome — success, rejection, or throw — becomes one tool message,
 *     so the model always learns what happened.
 */
export interface AgentLoopToolContext {
  readonly store: Pick<TaskStore, 'saveLoopState' | 'transitionTask'>;
  readonly readResults: ReadResultCache;
  readonly capabilities: TaskCapabilities;
  needsApproval(sideEffect: string): boolean;
  writeAlreadyApplied(task: TaskSnapshot, toolId: string, args: ProviderToolCall['arguments']): boolean;
  eventInput(task: TaskSnapshot, type: 'agent_loop.approval_requested', state: 'waiting_approval', attempt?: number): unknown;
  recordRequested(task: TaskSnapshot, iteration: number, call: ProviderToolCall): void;
  /** Records approval metadata and moves the task to waiting_approval. */
  requestApproval(task: TaskSnapshot, iteration: number, call: ProviderToolCall, sideEffect: string): void;
  recordReused(task: TaskSnapshot, iteration: number, call: ProviderToolCall, digest: string): void;
  recordExecuted(task: TaskSnapshot, iteration: number, call: ProviderToolCall, result: { readonly digest: string; readonly bytes: number }): void;
  recordFailed(task: TaskSnapshot, iteration: number, toolId: string, errorCode: string): void;
  /**
   * Durable bookkeeping for a consequential tool.
   *
   * `before` runs before the tool does; the returned handle commits the effect
   * once it succeeded, or discards the record when the tool provably did
   * nothing. A resumable task must consult this rather than trusting that a
   * crashed process never wrote.
   */
  sideEffect?(
    task: TaskSnapshot,
    call: ProviderToolCall,
    phase: 'before',
  ): { commit(resultDigest: string): void; abandon(): void } | { blocked: string };
}

/**
 * Runs every call in one assistant turn.
 *
 * Returns `paused` when a call needs approval: the remaining calls are saved as
 * a checkpoint and the task moves to `waiting_approval`. Returns `done` when the
 * turn was fully drained.
 */
export async function drainToolCalls(
  context: AgentLoopToolContext,
  task: TaskSnapshot,
  calls: readonly ProviderToolCall[],
  iteration: number,
  messages: ProviderMessage[],
  signal: AbortSignal,
): Promise<'done' | 'paused'> {
  const tools = context.capabilities.tools;
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    if (signal.aborted) throw new Error('Task was cancelled.');
    context.recordRequested(task, iteration, call);

    const definition = tools?.list().find((entry) => entry.id === call.name);
    if (!definition) {
      // An ungranted or unknown tool is a recorded failure, not an execution.
      context.recordFailed(task, iteration, call.name, 'unknown_tool');
      messages.push({ role: 'tool', toolCallId: call.id, content: 'error: unknown_tool' });
      continue;
    }

    if (context.needsApproval(definition.sideEffect)) {
      if (context.writeAlreadyApplied(task, call.name, call.arguments)) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: 'This identical write already completed; do not repeat it.',
        });
        continue;
      }
      context.store.saveLoopState(task.id, JSON.stringify({
        iteration,
        messages,
        pending: calls.slice(index).map((entry) => ({
          id: entry.id,
          name: entry.name,
          arguments: entry.arguments,
        })),
      }));
      context.requestApproval(task, iteration, call, definition.sideEffect);
      return 'paused';
    }

    if (definition.sideEffect === 'read') {
      const cached = context.readResults.get(task.id, task.attempt, call.name, call.arguments);
      if (cached) {
        context.recordReused(task, iteration, call, cached.digest);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `[reused: identical call, same result as before]\n${cached.summary}`,
        });
        continue;
      }
    }

    // A consequential tool is registered before it runs, so a crash inside the
    // effect leaves a durable `unknown` instead of a silent duplicate on retry.
    const effect = definition.sideEffect === 'read'
      ? undefined
      : context.sideEffect?.(task, call, 'before');
    if (effect && 'blocked' in effect) {
      context.recordFailed(task, iteration, call.name, effect.blocked);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `error: ${effect.blocked}`,
      });
      continue;
    }
    try {
      const result = await tools!.invoke(call.name, call.arguments);
      if (effect && !('blocked' in effect)) effect.commit(result.digest);
      context.recordExecuted(task, iteration, call, result);
      if (definition.sideEffect === 'read') {
        context.readResults.set(task.id, task.attempt, call.name, call.arguments, {
          summary: result.summary,
          digest: result.digest,
        });
      }
      messages.push({ role: 'tool', toolCallId: call.id, content: result.summary });
    } catch (cause) {
      // Be conservative: a throw does not prove the effect did not happen, so
      // the intent stays recorded. Only an explicit rejection that happens
      // before any work discards it.
      if (cause instanceof ToolRejectedError && effect && !('blocked' in effect)) effect.abandon();
      const code = cause instanceof ToolRejectedError ? cause.code : 'tool_failed';
      context.recordFailed(task, iteration, call.name, code);
      messages.push({ role: 'tool', toolCallId: call.id, content: `error: ${code}` });
    }
  }
  return 'done';
}

/** Exposed for tests: the digest a call is keyed by. */
export function toolCallDigest(call: ProviderToolCall): string {
  return digestArguments(call.arguments);
}
