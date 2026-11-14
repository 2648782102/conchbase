import type { ToolCallArguments, ToolCallProposal } from './tool-request.js';

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
  | { readonly kind: 'tool_calls'; readonly content: string; readonly calls: readonly ProviderToolCall[] }
  | ProviderToolCallObservationTurn;

export interface ModelAdapterInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly turnIndex: number;
  readonly signal?: AbortSignal;
  readonly messages?: readonly ProviderMessage[];
  readonly tools?: readonly ProviderToolDefinition[];
}

export interface ProviderToolDefinition {
  readonly id: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type ProviderMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ProviderToolCall[] }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: ToolCallArguments;
}

export interface ModelAdapter {
  nextTurn(input: ModelAdapterInput): Promise<ModelTurn>;
}

export interface StructuredModelAdapter {
  nextTurn(input: ModelAdapterInput): Promise<ProviderModelTurn>;
}
