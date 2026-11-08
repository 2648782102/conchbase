import {
  toolArgumentsDigest,
  validateToolCallProposal,
  type ToolCallProposal,
  type ToolRequestValidationIssue,
} from './tool-request.js';

export interface ProviderToolCallObservation {
  readonly version: 1;
  readonly kind: 'tool_call';
  readonly provider: 'openai-chat-completions';
  readonly providerToolCallId: string;
  readonly toolCall: ToolCallProposal;
  readonly argumentsDigest: string;
}

export class ProviderToolCallError extends Error {
  readonly details: readonly ToolRequestValidationIssue[];

  constructor(details: readonly ToolRequestValidationIssue[]) {
    super('Provider tool call does not match the accepted parsing boundary.');
    this.name = 'ProviderToolCallError';
    this.details = Object.freeze([...details]);
  }
}

const PROVIDER_TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const SENSITIVE_PROVIDER_TOOL_CALL_ID = /\b(?:api[_-]?key|access[_-]?token|token|password|secret|credential|private[_-]?key)\b|sk-|ghp_|github_pat_|Bearer|[A-Za-z0-9+/]{40,}={0,2}/i;
const MAX_ARGUMENTS_JSON_LENGTH = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function issue(path: string, reason: string): ToolRequestValidationIssue {
  return { path, reason };
}

function fail(details: readonly ToolRequestValidationIssue[]): never {
  throw new ProviderToolCallError(details);
}

export function parseOpenAiChatCompletionsToolCall(
  payload: unknown,
): ProviderToolCallObservation | null {
  if (!isRecord(payload)) {
    fail([issue('$', 'must be an object')]);
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    fail([issue('choices', 'must contain exactly one choice')]);
  }
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    fail([issue('choices[0]', 'must be an object')]);
  }
  const message = firstChoice.message;
  if (!isRecord(message)) {
    fail([issue('choices[0].message', 'must be an object')]);
  }
  const toolCalls = message.tool_calls;
  if (toolCalls === undefined) return null;
  if (typeof message.content === 'string' && message.content.trim().length > 0) {
    fail([issue('choices[0].message.content', 'must be empty when tool_calls is present')]);
  }
  if (message.content !== null
    && message.content !== undefined
    && typeof message.content !== 'string') {
    fail([issue('choices[0].message.content', 'must be null or a string')]);
  }
  if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
    fail([issue('choices[0].message.tool_calls', 'must contain exactly one tool call')]);
  }
  const toolCallValue = toolCalls[0];
  if (!isRecord(toolCallValue)) {
    fail([issue('choices[0].message.tool_calls[0]', 'must be an object')]);
  }
  const acceptedCallKeys = ['id', 'type', 'function'];
  if (Object.keys(toolCallValue).some((key) => !acceptedCallKeys.includes(key))) {
    fail([issue('choices[0].message.tool_calls[0]', 'has unknown fields')]);
  }
  if (toolCallValue.type !== 'function') {
    fail([issue('choices[0].message.tool_calls[0].type', 'must be function')]);
  }
  const providerToolCallId = toolCallValue.id;
  if (typeof providerToolCallId !== 'string'
    || !PROVIDER_TOOL_CALL_ID_PATTERN.test(providerToolCallId)
    || SENSITIVE_PROVIDER_TOOL_CALL_ID.test(providerToolCallId)) {
    fail([issue('choices[0].message.tool_calls[0].id', 'must be a bounded opaque identifier')]);
  }
  const functionValue = toolCallValue.function;
  if (!isRecord(functionValue)) {
    fail([issue('choices[0].message.tool_calls[0].function', 'must be an object')]);
  }
  const acceptedFunctionKeys = ['name', 'arguments'];
  if (Object.keys(functionValue).some((key) => !acceptedFunctionKeys.includes(key))) {
    fail([issue('choices[0].message.tool_calls[0].function', 'has unknown fields')]);
  }
  const argumentsJson = functionValue.arguments;
  if (typeof argumentsJson !== 'string' || argumentsJson.length > MAX_ARGUMENTS_JSON_LENGTH) {
    fail([issue('choices[0].message.tool_calls[0].function.arguments', 'must be bounded JSON text')]);
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(argumentsJson);
  } catch {
    fail([issue('choices[0].message.tool_calls[0].function.arguments', 'must be valid JSON text')]);
  }
  if (!isRecord(parsedArguments)) {
    fail([issue('choices[0].message.tool_calls[0].function.arguments', 'must parse to an object')]);
  }
  const issues: ToolRequestValidationIssue[] = [];
  const toolCall = validateToolCallProposal({
    toolName: functionValue.name,
    arguments: parsedArguments,
  }, issues);
  if (issues.length > 0) fail(issues);
  if (toolCall === null) {
    fail([issue('choices[0].message.tool_calls[0].function', 'must normalize to one tool call')]);
  }
  return Object.freeze({
    version: 1,
    kind: 'tool_call',
    provider: 'openai-chat-completions',
    providerToolCallId,
    toolCall,
    argumentsDigest: toolArgumentsDigest(toolCall.arguments),
  });
}
