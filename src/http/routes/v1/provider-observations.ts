import type { FastifyInstance } from 'fastify';
import {
  ProviderToolCallError,
  parseOpenAiChatCompletionsToolCall,
} from '../../../runtime/provider-tool-call.js';
import { ToolRequestValidationError } from '../../../runtime/tool-request.js';

const observationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'provider', 'payload'],
  properties: {
    version: { const: 1 },
    provider: { const: 'openai-chat-completions' },
    payload: {
      type: 'object',
      minProperties: 1,
      maxProperties: 8,
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validatePayload(payload: unknown): readonly { path: string; reason: string }[] {
  const issues: { path: string; reason: string }[] = [];
  if (!isRecord(payload)) {
    issues.push({ path: 'payload', reason: 'must be an object' });
    return issues;
  }
  if (Object.keys(payload).some((key) => key !== 'choices')) {
    issues.push({ path: 'payload', reason: 'must contain only the accepted provider choices field' });
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    issues.push({ path: 'payload.choices', reason: 'must contain exactly one choice' });
  } else {
    const choice = choices[0];
    if (!isRecord(choice)) {
      issues.push({ path: 'payload.choices[0]', reason: 'must be an object' });
    } else if (Object.keys(choice).some((key) => key !== 'message')) {
      issues.push({ path: 'payload.choices[0]', reason: 'must contain only a message field' });
    } else {
      const message = choice.message;
      if (!isRecord(message)) {
        issues.push({ path: 'payload.choices[0].message', reason: 'must be an object' });
      } else if (Object.keys(message).some((key) => key !== 'content' && key !== 'tool_calls')) {
        issues.push({
          path: 'payload.choices[0].message',
          reason: 'must contain only content and tool_calls fields',
        });
      }
    }
  }
  const serialized = JSON.stringify(payload);
  if (serialized.length > 12_000
    || /https?:\/\/|\b(?:api[_-]?key|access[_-]?token|password|secret|credential|private[_-]?key)\b|sk-|ghp_|github_pat_|Bearer\s+/i.test(serialized)) {
    issues.push({ path: 'payload', reason: 'must be bounded and must not contain secrets or URLs' });
  }
  return issues;
}

export function registerProviderObservationRoutes(app: FastifyInstance): void {
  void app.register(async (scope) => {
    scope.setErrorHandler((cause, _request, reply) => {
      if ((cause as { validation?: unknown }).validation) {
        void reply.code(400).send({
          error: 'Provider observation does not match the versioned contract.',
          details: [{ path: '$', reason: 'must match the accepted request schema' }],
        });
        return;
      }
      void reply.code(500).send({ error: 'Internal runtime error.' });
    });

    scope.post(
      '/v1/provider-observations/tool-calls',
      { schema: { body: observationSchema } },
      async (request, reply) => {
        const body = request.body as { payload: unknown };
        const issues = validatePayload(body.payload);
      if (issues.length > 0) {
        return reply.code(400).send({
          error: 'Provider observation does not match the versioned contract.',
          details: issues,
        });
      }
      try {
        const observation = parseOpenAiChatCompletionsToolCall(body.payload);
        return { observation };
      } catch (cause) {
        if (cause instanceof ProviderToolCallError) {
          return reply.code(400).send({
            error: 'Provider tool call does not match the accepted parsing boundary.',
            details: cause.details,
          });
        }
        if (cause instanceof ToolRequestValidationError) {
          return reply.code(400).send({ error: cause.message, details: cause.details });
        }
        throw cause;
      }
      },
    );
  });
}
