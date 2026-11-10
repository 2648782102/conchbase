import type { ModelAdapter, ModelTurn } from '../../src/runtime/model-adapter.js';
import type { ToolApprovalSource } from '../../src/runtime/task-runner.js';

export const FAKE_SECRET_MARKER = 'fixture-secret-never-logged';

interface HealthResponseFixture {
  readonly status: 'ok';
  readonly service: 'conchbase';
  readonly apiVersion: 1;
}

interface RuntimeResponseFixture {
  readonly name: 'Conchbase';
  readonly version: string;
  readonly state: 'ready';
  readonly capabilities: readonly string[];
}

export const HEALTH_RESPONSE_FIXTURE: HealthResponseFixture = Object.freeze({
  status: 'ok',
  service: 'conchbase',
  apiVersion: 1,
});

export const RUNTIME_RESPONSE_FIXTURE: RuntimeResponseFixture = Object.freeze({
  name: 'Conchbase',
  version: '1.0.0',
  state: 'ready',
  capabilities: Object.freeze([] as string[]),
});

export const READ_ONLY_TOOL_CALL: ModelTurn = Object.freeze({
  kind: 'tool_call',
  toolName: 'read_file',
  output: FAKE_SECRET_MARKER,
});

export const DENIED_TOOL_CALL: ModelTurn = Object.freeze({
  kind: 'tool_call',
  toolName: 'delete_file',
  output: 'denied',
});

export const FINAL_TURN: ModelTurn = Object.freeze({
  kind: 'final',
  output: 'done',
});

export function mutableApprovalSource(
  approvedToolNames: readonly string[],
): ToolApprovalSource & { revoke(toolName: string): void; grant(toolName: string): void } {
  const approved = new Set(approvedToolNames);

  return {
    isApproved(toolName: string): boolean {
      return approved.has(toolName);
    },
    revoke(toolName: string): void {
      approved.delete(toolName);
    },
    grant(toolName: string): void {
      approved.add(toolName);
    },
  };
}

export function scriptedModelAdapter(turns: readonly ModelTurn[]): ModelAdapter {
  const remaining = [...turns];

  return {
    async nextTurn(): Promise<ModelTurn> {
      const turn = remaining.shift();
      if (!turn) throw new Error('Scripted model adapter has no remaining turn.');
      return turn;
    },
  };
}
