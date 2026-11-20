/**
 * The one place that answers "may this action run?".
 *
 * Before this module the answer lived in four places — the agent loop's
 * `requiresApproval`, the plugin registry's independent guard, the tool
 * registry's per-definition flag, and controlled execution's grant ledger —
 * and they disagreed. The MCP default-to-`read` bug was one symptom: a path
 * that never consulted the shared rule.
 *
 * Design constraints, all deliberate:
 *
 * 1. Pure. No IO, no clock, no persistence. A decision is a function of the
 *    request and the policy snapshot handed in, so it can be enumerated in
 *    tests and cannot drift with process state.
 * 2. One decision per action, total. Every action maps to exactly one of
 *    `allow`, `approve`, `deny`; there is no "implicitly fine" outcome.
 * 3. Boundaries are not negotiable. A permission level may waive approval and
 *    may waive the grant list, but the workspace boundary and the secret
 *    boundary are inputs to the decision, never things a level can switch off.
 */

/** How much the operator trusts this Runtime. */
export type PermissionLevel = 'strict' | 'standard' | 'trusted' | 'unbounded';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = Object.freeze([
  'strict', 'standard', 'trusted', 'unbounded',
]);

/** The kind of effect an action has, independent of which tool implements it. */
export type ActionEffect = 'read' | 'write' | 'external';

/** What the Runtime knows about the action being attempted. */
export interface PolicyRequest {
  readonly level: PermissionLevel;
  /** Stable tool id, e.g. `workspace_write` or `mcp_notes_post`. */
  readonly action: string;
  readonly effect: ActionEffect;
  /**
   * Whether the pinned Agent revision granted this action.
   *
   * Still meaningful under `unbounded`: the level waives the requirement, it
   * does not pretend the grant existed.
   */
  readonly granted: boolean;
  /**
   * Whether the action stays inside the Runtime's own boundaries. A request
   * that left the workspace is denied at every level.
   */
  readonly withinBoundary: boolean;
}

export type PolicyDecision = 'allow' | 'approve' | 'deny';

export interface PolicyOutcome {
  readonly decision: PolicyDecision;
  /** Why, in a phrase an operator can act on. Never includes arguments. */
  readonly reason: string;
  /** Whether a human must confirm before the action runs. */
  readonly requiresApproval: boolean;
}

/**
 * Level → whether the grant list is enforced.
 *
 * `unbounded` is the only level that waives it. Everything else requires the
 * pinned revision to have granted the action, because "the Agent was allowed to
 * use this" and "the user approved this one call" are different questions.
 */
const GRANT_ENFORCED: Readonly<Record<PermissionLevel, boolean>> = Object.freeze({
  strict: true,
  standard: true,
  trusted: true,
  unbounded: false,
});

/**
 * Level → which effects need a human before running.
 *
 * `strict` treats reading as consequential too: it exists for the case where
 * even observing the workspace should be confirmed.
 */
const APPROVAL_MATRIX: Readonly<Record<PermissionLevel, Readonly<Record<ActionEffect, boolean>>>> = Object.freeze({
  strict: Object.freeze({ read: true, write: true, external: true }),
  standard: Object.freeze({ read: false, write: true, external: true }),
  trusted: Object.freeze({ read: false, write: false, external: false }),
  unbounded: Object.freeze({ read: false, write: false, external: false }),
});

const REASON: Readonly<Record<PolicyDecision, string>> = Object.freeze({
  allow: 'allowed by policy',
  approve: 'requires operator approval',
  deny: 'denied by policy',
});

/**
 * Decides one action.
 *
 * Order matters and is part of the contract: boundary first (nothing outside
 * the workspace is ever allowed, at any level), then grant scope, then approval.
 * Reordering these would let a level waive a boundary it must not waive.
 */
export function decidePolicy(request: PolicyRequest): PolicyOutcome {
  if (!request.withinBoundary) {
    return Object.freeze({
      decision: 'deny',
      reason: 'outside the workspace boundary',
      requiresApproval: false,
    });
  }

  if (GRANT_ENFORCED[request.level] && !request.granted) {
    return Object.freeze({
      decision: 'deny',
      reason: 'not granted to this Agent revision',
      requiresApproval: false,
    });
  }

  if (APPROVAL_MATRIX[request.level][request.effect]) {
    return Object.freeze({
      decision: 'approve',
      reason: REASON.approve,
      requiresApproval: true,
    });
  }

  return Object.freeze({
    decision: 'allow',
    reason: REASON.allow,
    requiresApproval: false,
  });
}

/** Whether a level enforces the pinned grant list. Exposed for docs and tests. */
export function grantEnforced(level: PermissionLevel): boolean {
  return GRANT_ENFORCED[level];
}

/** Whether a level requires approval for an effect. Exposed for docs and tests. */
export function approvalRequired(level: PermissionLevel, effect: ActionEffect): boolean {
  return APPROVAL_MATRIX[level][effect];
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(value);
}
