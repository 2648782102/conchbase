import type { ProviderMessage, ProviderToolCall } from './model-adapter.js';
import type { ReadResultCache } from './read-result-cache.js';
import { ToolRejectedError, type ToolSideEffect } from './tool-provider.js';
import { digestArguments } from './tool-arguments.js';
import type { TaskCapabilities } from './task-capabilities.js';
import type { TaskSnapshot, TaskStore } from './task-store.js';
import { executeToolCall } from './tool-execution.js';

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
  needsApproval(sideEffect: ToolSideEffect): boolean;
  writeAlreadyApplied(task: TaskSnapshot, toolId: string, args: ProviderToolCall['arguments']): boolean;
  eventInput(task: TaskSnapshot, type: 'agent_loop.approval_requested', state: 'waiting_approval', attempt?: number): unknown;
  recordRequested(task: TaskSnapshot, iteration: number, call: ProviderToolCall): void;
  /** Records approval metadata and moves the task to waiting_approval. */
  requestApproval(task: TaskSnapshot, iteration: number, call: ProviderToolCall, sideEffect: ToolSideEffect): void;
  recordReused(task: TaskSnapshot, iteration: number, call: ProviderToolCall, digest: string): void;
  recordExecuted(task: TaskSnapshot, iteration: number, call: ProviderToolCall, result: {
    readonly digest: string;
    readonly bytes: number;
    readonly truncated?: boolean;
    readonly evidence?: { readonly facts: Readonly<Record<string, string | number | boolean>> };
  }): void;
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

    // The decision order lives in `executeToolCall`; this loop only translates
    // its outcome into events and a tool message. Keeping the order in one place
    // is what stops `sideEffect === 'read'` from being re-derived here and
    // drifting from the other branches that used to repeat it.
    const outcome = await executeToolCall(context, task, call, {
      toolId: call.name,
      sideEffect: definition.sideEffect,
      // `ToolProvider.invoke` is allowed to be synchronous (the built-ins are),
      // so normalise here rather than widening the pipeline's contract.
      invoke: async (args) => tools!.invoke(call.name, args),
    });

    switch (outcome.kind) {
      case 'approval_required':
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
      case 'already_applied':
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: 'This identical write already completed; do not repeat it.',
        });
        continue;
      case 'reused':
        context.recordReused(task, iteration, call, outcome.digest);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `[reused: identical call, same result as before]\n${outcome.summary}`,
        });
        continue;
      case 'executed':
        context.recordExecuted(task, iteration, call, outcome);
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.summary });
        continue;
      case 'failed':
        context.recordFailed(task, iteration, call.name, outcome.code);
        messages.push({ role: 'tool', toolCallId: call.id, content: `error: ${outcome.code}` });
        continue;
    }
  }
  return 'done';
}
