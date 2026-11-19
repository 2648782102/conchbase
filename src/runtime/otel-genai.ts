/**
 * Attribute names from the OpenTelemetry GenAI semantic conventions.
 *
 * Conchbase keeps its own event vocabulary; these names are attached as
 * *additional* data so an operator can forward events to any OTel-aware backend
 * without a translation layer. Renaming our own fields would break existing
 * clients, so we add rather than convert.
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 * The conventions are still marked development; treat these as a stable
 * subset we deliberately chose, not as a promise to track every revision.
 */

export const OTEL_GENAI_ATTRIBUTES = Object.freeze({
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  responseFinishReasons: 'gen_ai.response.finish_reasons',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  agentName: 'gen_ai.agent.name',
  agentId: 'gen_ai.agent.id',
  conversationId: 'gen_ai.conversation.id',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  systemInstructions: 'gen_ai.system_instructions',
} as const);

export type OtelGenAiAttribute =
  typeof OTEL_GENAI_ATTRIBUTES[keyof typeof OTEL_GENAI_ATTRIBUTES];

/**
 * OTel attribute values are limited to bounded scalars. Conchbase events carry
 * the same scalar type, so an adapter can forward these fields verbatim.
 */
export type OtelGenAiValue = string | number | boolean;

export interface OtelGenAiContext {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly conversationId?: string;
}

/**
 * Builds the additive `otel.gen_ai.*` block for a Conchbase event. The keys are
 * prefixed with `otel.` so they can never collide with an existing Conchbase
 * event field, and so a reader can tell provenance at a glance.
 */
export function otelGenAiAttributes(
  context: OtelGenAiContext,
  extra: Readonly<Record<string, OtelGenAiValue>> = {},
): Readonly<Record<string, OtelGenAiValue>> {
  const attributes: Record<string, OtelGenAiValue> = {};
  if (context.providerId) attributes[OTEL_GENAI_ATTRIBUTES.providerName] = context.providerId;
  if (context.modelId) attributes[OTEL_GENAI_ATTRIBUTES.requestModel] = context.modelId;
  if (context.agentId) attributes[OTEL_GENAI_ATTRIBUTES.agentId] = context.agentId;
  if (context.agentName) attributes[OTEL_GENAI_ATTRIBUTES.agentName] = context.agentName;
  if (context.conversationId) attributes[OTEL_GENAI_ATTRIBUTES.conversationId] = context.conversationId;
  Object.assign(attributes, extra);
  return Object.freeze(attributes);
}

/**
 * Flattens attributes into the event `data` shape. Dots are preserved because
 * OTel attribute keys are dotted by definition and the event store accepts
 * bounded scalar keys.
 */
export function flattenOtelAttributes(
  attributes: Readonly<Record<string, OtelGenAiValue>>,
): Record<string, OtelGenAiValue> {
  const flattened: Record<string, OtelGenAiValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    flattened[`otel.${key}`] = value;
  }
  return flattened;
}
