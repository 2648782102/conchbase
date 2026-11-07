export type ModelTurn =
  | {
    readonly kind: 'tool_call';
    readonly toolName: string;
    readonly output: string;
  }
  | {
    readonly kind: 'final';
    readonly output: string;
  };

export interface ModelAdapterInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly turnIndex: number;
  readonly signal?: AbortSignal;
}

export interface ModelAdapter {
  nextTurn(input: ModelAdapterInput): Promise<ModelTurn>;
}
