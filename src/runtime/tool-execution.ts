import { ToolRejectedError, type ToolSideEffect } from './tool-provider.js';
import type { ProviderToolCall } from './model-adapter.js';
import type { TaskSnapshot } from './task-store.js';

/**
 * One tool call, decided in one place.
 *
 * The order below used to live inline in the agent loop as four separate `if`
 * blocks over `definition.sideEffect`, with `sideEffect === 'read'` written out
 * three times. Each occurrence had to agree with the others, and a change to
 * one could silently diverge — the same shape that produced the MCP
 * default-to-read bug.
 *
 * Extracting it does not change behaviour. It makes the order a named contract
 * that can be tested directly, and it keeps `ToolSideEffect` a closed union all
 * the way down instead of degrading to `string` at each boundary.
 */

/** What a single call did, as one value rather than a set of booleans. */
export type ToolOutcome =
  /** The tool ran; `summary` is what the model is told. */
  | {
    readonly kind: 'executed';
    readonly summary: string;
    readonly digest: string;
    readonly bytes: number;
    /** Whether the summary was a bounded slice of a larger result. */
    readonly truncated?: boolean;
    /** Bounded, checkable facts the tool is asserting. */
    readonly evidence?: { readonly facts: Readonly<Record<string, string | number | boolean>> };
  }
  /** An identical read in this attempt already produced this result. */
  | { readonly kind: 'reused'; readonly summary: string; readonly digest: string }
  /** An identical write already succeeded; repeating it would double the effect. */
  | { readonly kind: 'already_applied' }
  /** The call must wait for a human. The caller persists the checkpoint. */
  | { readonly kind: 'approval_required' }
  /** The tool could not run, for a bounded reason the model can act on. */
  | { readonly kind: 'failed'; readonly code: string };

/** Everything the pipeline needs from the Runtime, kept narrow on purpose. */
export interface ToolExecutionPorts {
  /** Whether this side effect class must pause for a human. */
  needsApproval(sideEffect: ToolSideEffect): boolean;
  /** Whether an identical write already completed in this attempt. */
  writeAlreadyApplied(task: TaskSnapshot, toolId: string, args: ProviderToolCall['arguments']): boolean;
  /** Reuse of an identical read within one attempt. */
  readonly readResults: {
    get(taskId: string, attempt: number, toolId: string, args: ProviderToolCall['arguments']): { readonly summary: string; readonly digest: string } | undefined;
    set(taskId: string, attempt: number, toolId: string, args: ProviderToolCall['arguments'], value: { readonly summary: string; readonly digest: string }): void;
  };
  /**
   * Durable side-effect bookkeeping, for effects that are not reads.
   *
   * `before` must run *before* the tool does, so a crash inside the effect
   * leaves a durable `unknown` rather than a silent duplicate on retry.
   */
  sideEffect?(
    task: TaskSnapshot,
    call: ProviderToolCall,
    phase: 'before',
  ): { commit(resultDigest: string): void; abandon(): void } | { blocked: string };
}

export interface ToolInvocation {
  readonly toolId: string;
  readonly sideEffect: ToolSideEffect;
  invoke(args: ProviderToolCall['arguments']): Promise<{
    readonly summary: string;
    readonly digest: string;
    readonly bytes: number;
    readonly truncated?: boolean;
    readonly evidence?: { readonly facts: Readonly<Record<string, string | number | boolean>> };
  }>;
}

/**
 * Runs one call through the fixed decision order.
 *
 * The order is the contract, and it is the same order the loop used:
 *  1. approval — a consequential call pauses before anything is recorded;
 *  2. idempotency — an identical write that already landed is not repeated;
 *  3. read reuse — an identical read in this attempt is served from cache;
 *  4. execution — with the side-effect intent recorded first;
 *  5. bookkeeping — commit the effect, or cache the read.
 *
 * A tool that throws becomes `failed`, never an exception: the model must
 * always learn what happened. A rejection that provably did nothing discards
 * its intent so a corrected call is not blocked.
 */
export async function executeToolCall(
  ports: ToolExecutionPorts,
  task: TaskSnapshot,
  call: ProviderToolCall,
  tool: ToolInvocation,
): Promise<ToolOutcome> {
  if (ports.needsApproval(tool.sideEffect)) {
    if (ports.writeAlreadyApplied(task, tool.toolId, call.arguments)) {
      return Object.freeze({ kind: 'already_applied' });
    }
    return Object.freeze({ kind: 'approval_required' });
  }

  const isRead = tool.sideEffect === 'read';
  if (isRead) {
    const cached = ports.readResults.get(task.id, task.attempt, tool.toolId, call.arguments);
    if (cached) {
      return Object.freeze({ kind: 'reused', summary: cached.summary, digest: cached.digest });
    }
  }

  // A consequential tool is registered before it runs, so a crash inside the
  // effect leaves a durable `unknown` instead of a silent duplicate on retry.
  const effect = isRead ? undefined : ports.sideEffect?.(task, call, 'before');
  if (effect && 'blocked' in effect) {
    return Object.freeze({ kind: 'failed', code: effect.blocked });
  }

  try {
    const result = await tool.invoke(call.arguments);
    if (effect && !('blocked' in effect)) effect.commit(result.digest);
    if (isRead) {
      ports.readResults.set(task.id, task.attempt, tool.toolId, call.arguments, {
        summary: result.summary,
        digest: result.digest,
      });
    }
    return Object.freeze({
      kind: 'executed',
      summary: result.summary,
      digest: result.digest,
      bytes: result.bytes,
      ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
      ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    });
  } catch (cause) {
    // A throw does not prove the effect did not happen, so the intent stays
    // recorded. Only an explicit rejection that happens before any work
    // discards it, so a corrected call is not blocked by a stale intent.
    if (cause instanceof ToolRejectedError && effect && !('blocked' in effect)) effect.abandon();
    const code = cause instanceof ToolRejectedError ? cause.code : 'tool_failed';
    return Object.freeze({ kind: 'failed', code });
  }
}
