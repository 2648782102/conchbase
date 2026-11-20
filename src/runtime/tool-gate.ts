import type { ExecutionMode } from '../config/runtime-config.js';
import type { ToolSideEffect } from './tool-provider.js';
import {
  approvalRequired,
  decidePolicy,
  type ActionEffect,
  type PermissionLevel,
  type PolicyOutcome,
} from '../kernel/policy.js';

/**
 * Runtime adapter over the kernel's policy decision.
 *
 * This module no longer owns a rule. It translates the Runtime's current
 * configuration into a kernel request and returns the kernel's answer, so the
 * approval rule exists in exactly one place (`src/kernel/policy.ts`).
 */

/**
 * Maps the legacy two-value setting onto a kernel level.
 *
 * `restricted` was never "deny everything" and `unrestricted` was never "skip
 * the grant list"; they only toggled approval. `standard` and `trusted` say the
 * same thing with the boundary and grant rules made explicit, so the old names
 * stay valid while the new levels become the way forward.
 */
export function levelForExecutionMode(mode: ExecutionMode): PermissionLevel {
  return mode === 'unrestricted' ? 'trusted' : 'standard';
}

/**
 * The effective level for a Runtime.
 *
 * `permissionLevel` is authoritative when present because it is resolved once
 * from the operator's environment. The mode fallback keeps every existing
 * caller and configuration working unchanged.
 */
export function resolveLevel(
  permissionLevel: PermissionLevel | undefined,
  mode: ExecutionMode,
): PermissionLevel {
  return permissionLevel ?? levelForExecutionMode(mode);
}

/**
 * Narrows a tool's effect class to the kernel's action class.
 *
 * The two unions currently have the same members, so this is an identity at
 * runtime. It is written as an explicit mapping rather than an assertion so
 * that if either union gains a member the compiler fails here instead of
 * silently admitting an effect the policy has no rule for.
 */
function asEffect(sideEffect: ToolSideEffect): ActionEffect {
  switch (sideEffect) {
    case 'read': return 'read';
    case 'write': return 'write';
    case 'external': return 'external';
  }
}

/**
 * Whether a tool call must pause for human approval.
 *
 * Kept as a narrow helper because most callers only need this bit; the full
 * decision (including denial) is available through `decideToolAction`.
 */
export function requiresApproval(mode: ExecutionMode, sideEffect: ToolSideEffect): boolean {
  return approvalRequired(levelForExecutionMode(mode), asEffect(sideEffect));
}

export interface ToolPolicyInput {
  /** The resolved level; preferred over `mode` when both are present. */
  readonly level?: PermissionLevel;
  readonly mode?: ExecutionMode;
  /** Stable tool id, used only for the audit reason. */
  readonly action: string;
  readonly sideEffect: ToolSideEffect;
  readonly granted: boolean;
  readonly withinBoundary?: boolean;
}

/**
 * The full decision for one tool call.
 *
 * `withinBoundary` defaults to true because the workspace check happens inside
 * the tool providers, which reject an escaping path before any effect. A caller
 * that knows the request left the boundary should pass false to get `deny`.
 */
export function decideToolAction(input: ToolPolicyInput): PolicyOutcome {
  const level = input.level ?? levelForExecutionMode(input.mode ?? 'restricted');
  return decidePolicy({
    level,
    action: input.action,
    effect: asEffect(input.sideEffect),
    granted: input.granted,
    withinBoundary: input.withinBoundary ?? true,
  });
}
