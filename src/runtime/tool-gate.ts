import type { ExecutionMode } from '../config/runtime-config.js';

/**
 * Whether a tool call must pause for human approval.
 *
 * Scope (`grantedCapabilities`) and policy are decided elsewhere; this only
 * answers the narrower question of whether the call is consequential enough to
 * need a person. It is a pure function because the answer is a security
 * boundary: unrestricted mode must not silently approve a tool the Agent was
 * never granted, and restricted mode must not let an external call through.
 */
export function requiresApproval(mode: ExecutionMode, sideEffect: string): boolean {
  if (mode === 'unrestricted') return false;
  return sideEffect === 'write' || sideEffect === 'external';
}
