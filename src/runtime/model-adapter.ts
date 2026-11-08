import type { ToolCallProposal } from './tool-request.js';

export interface ProviderToolCallObservation {
  readonly version: 1;
  readonly kind: 'tool_call';
  readonly provider: 'openai-chat-completions';
  readonly providerToolCallId: string;
  readonly toolCall: ToolCallProposal;
  readonly argumentsDigest: string;
}

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

export type ProviderToolCallObservationTurn = {
  readonly kind: 'tool_call_observation';
  readonly observation: ProviderToolCallObservation;
};

export type ProviderModelTurn =
  | { readonly kind: 'final'; readonly output: string }
  | ProviderToolCallObservationTurn;

export type StreamingModelTurn =
  | { readonly kind: 'final'; readonly output: string }
  | ProviderToolCallObservationTurn;

export interface ModelAdapterInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly turnIndex: number;
  readonly signal?: AbortSignal;
}

export interface ModelAdapter {
  nextTurn(input: ModelAdapterInput): Promise<ModelTurn>;
}

export interface StructuredModelAdapter {
  nextTurn(input: ModelAdapterInput): Promise<ProviderModelTurn>;
}
