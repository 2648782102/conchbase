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
 * 3. Only ceremony is negotiable. A permission level may waive *approval*; it
 *    never waives the grant list, the workspace boundary, or the secret
 *    boundary. Those are inputs to the decision, not switches a level owns.
 */

/** How much the operator trusts this Runtime. */
export type PermissionLevel = 'strict' | 'standard' | 'trusted';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = Object.freeze([
  'strict', 'standard', 'trusted',
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
   * Enforced at every level. An ungranted action is denied, and there is no
   * level that waives it: a config value must not be able to switch off the
   * revision pin that `capability-grants.ts` maintains.
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
 * Level → which effects need a human before running.
 *
 * `strict` treats reading as consequential too: it exists for the case where
 * even observing the workspace should be confirmed.
 */
const APPROVAL_MATRIX: Readonly<Record<PermissionLevel, Readonly<Record<ActionEffect, boolean>>>> = Object.freeze({
  strict: Object.freeze({ read: true, write: true, external: true }),
  standard: Object.freeze({ read: false, write: true, external: true }),
  trusted: Object.freeze({ read: false, write: false, external: false }),
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

  // No level waives this. A level answers "how much ceremony surrounds an
  // allowed action", never "what is this Agent allowed to touch":
  // `capability-grants.ts` promises grants can only narrow, and a config value
  // able to switch that off would make the promise decorative. The check is
  // written inline rather than behind a flag so adding a waiver has to delete
  // it, not flip a boolean.
  if (!request.granted) {
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

/** Whether a level requires approval for an effect. Exposed for docs and tests. */
export function approvalRequired(level: PermissionLevel, effect: ActionEffect): boolean {
  return APPROVAL_MATRIX[level][effect];
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(value);
}

/**
 * How restrictive each level is. Higher tightens.
 *
 * Used only to decide whether a conversation may ask for a level, never to
 * compare two policies for any other purpose.
 */
const STRICTNESS: Readonly<Record<PermissionLevel, number>> = Object.freeze({
  trusted: 0,
  standard: 1,
  strict: 2,
});

/**
 * Narrows a requested level to what the operator allows.
 *
 * A conversation may ask to be *more* cautious than the Runtime (`standard` →
 * `strict`); it may never ask to be less. Without this, "choose your permission
 * level in the composer" is a UI for turning off approval: a model that
 * requested a tool would be one dropdown change away from running unapproved,
 * and the operator's setting would mean nothing.
 *
 * Loosening is not a validation error the caller could retry around — it is
 * silently clamped, and the effective level is reported back so the client can
 * show what actually applied.
 */
export function narrowPermissionLevel(
  operatorLevel: PermissionLevel,
  requested: PermissionLevel | undefined,
): PermissionLevel {
  if (requested === undefined) return operatorLevel;
  return STRICTNESS[requested] > STRICTNESS[operatorLevel] ? requested : operatorLevel;
}

/** A grant as the kernel sees it: a kind and a name, nothing more. */
export interface ScopedGrant {
  readonly kind: 'tool' | 'skill';
  readonly name: string;
}

export interface ScopeResult {
  /** Registered tool names the tool grants cover, in registration order. */
  readonly allowed: readonly string[];
  /** Registered skill names the skill grants cover, in registration order. */
  readonly skills: readonly string[];
  /**
   * Granted names that are not registered.
   *
   * Not an error — an inert grant is a normal state when a tool is removed —
   * but it is reported so a typo in an Agent profile can be seen instead of
   * silently doing nothing.
   */
  readonly unavailable: readonly string[];
}

/**
 * Narrows a registered set to what an Agent revision was granted.
 *
 * The rule is one-directional by construction: the output is always a subset of
 * `registered`, so no grant can name something into existence. This is the
 * kernel's answer to "may this Agent use this?", which previously lived in
 * `capability-grants.ts` and therefore had a second owner.
 */
export function scopeToolSet(
  registered: { readonly tools: readonly string[]; readonly skills?: readonly string[] },
  grants: readonly ScopedGrant[],
): ScopeResult {
  const tools = registered.tools;
  const skills = registered.skills ?? [];
  const available = new Set([...tools, ...skills]);
  const toolGrants = new Set(grants.filter((grant) => grant.kind === 'tool').map((grant) => grant.name));
  const skillGrants = new Set(grants.filter((grant) => grant.kind === 'skill').map((grant) => grant.name));
  // Tools and skills are separate namespaces: a grant of one kind must never
  // authorize the other, even when the names collide.
  const allowed = tools.filter((name) => toolGrants.has(name));
  const grantedSkills = skills.filter((name) => skillGrants.has(name));
  const unavailable = [...new Set([...toolGrants, ...skillGrants])].filter((name) => !available.has(name));
  return Object.freeze({
    allowed: Object.freeze(allowed),
    skills: Object.freeze(grantedSkills),
    unavailable: Object.freeze(unavailable),
  });
}
