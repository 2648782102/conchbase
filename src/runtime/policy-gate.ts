export type ToolDecision = 'allowed' | 'approval_required' | 'denied';

export interface ToolPolicy {
  readonly allowedTools: readonly string[];
  readonly approvalRequiredTools: readonly string[];
}

export interface ToolRequest {
  readonly toolName: string;
}

export interface ToolExecutionRequest extends ToolRequest {
  readonly approved: boolean;
}

export interface ToolGateResult {
  readonly decision: ToolDecision;
  readonly executed: boolean;
}

export class ToolExecutionDeniedError extends Error {
  constructor(readonly decision: ToolDecision) {
    super(`Tool execution is not authorized: ${decision}`);
    this.name = 'ToolExecutionDeniedError';
  }
}

export function decideToolPolicy(
  policy: ToolPolicy,
  request: ToolRequest,
): ToolDecision {
  if (policy.allowedTools.includes(request.toolName)) return 'allowed';
  if (policy.approvalRequiredTools.includes(request.toolName)) {
    return 'approval_required';
  }
  return 'denied';
}

export function executeToolThroughGate<T>(
  policy: ToolPolicy,
  request: ToolExecutionRequest,
  execute: (toolName: string) => T,
): ToolGateResult & { readonly result?: T } {
  const decision = decideToolPolicy(policy, request);
  const permitted = decision === 'allowed'
    || (decision === 'approval_required' && request.approved);

  if (!permitted) {
    throw new ToolExecutionDeniedError(decision);
  }

  return {
    decision,
    executed: true,
    result: execute(request.toolName),
  };
}
