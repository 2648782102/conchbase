import { createHash, randomUUID } from 'node:crypto';
import type { AgentDetail } from './agent-profile.js';
import type { TaskService } from './task-service.js';
import type { TaskSnapshot } from './task-store.js';

export const AGENT_CHAT_CONTRACT_VERSION = '1.5.0';

export const AGENT_CHAT_PUBLIC_PATHS = Object.freeze([
  '/v1/agent-chat/agents',
  '/v1/agent-chat/conversations',
  '/v1/agent-chat/conversations/{conversationId}',
  '/v1/agent-chat/conversations/{conversationId}/messages',
] as const);

export const AGENT_CHAT_PUBLIC_PATH_COUNT = AGENT_CHAT_PUBLIC_PATHS.length;

export type AgentChatMessageAuthor = 'user' | 'assistant' | 'runtime';
export type AgentChatMessageState = 'published' | 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface AgentChatAgentView {
  readonly id: string;
  readonly name: string;
  readonly currentRevisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly isDefault: boolean;
  readonly archived: boolean;
}

export interface AgentChatMessage {
  readonly id: string;
  readonly sequence: number;
  readonly author: AgentChatMessageAuthor;
  readonly body: string;
  readonly state: AgentChatMessageState;
  readonly taskId: string | null;
  readonly error: string | null;
}

export interface AgentChatConversationView {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly id: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configurationRevisionId: string;
  readonly messages: readonly AgentChatMessage[];
}

export interface AgentChatMessageResult {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversationId: string;
  readonly userMessage: AgentChatMessage;
  readonly assistantMessage: AgentChatMessage;
}

interface ConversationRecord {
  readonly id: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configurationRevisionId: string;
  readonly messages: AgentChatMessage[];
  readonly idempotency: Map<string, string>;
}

export class AgentChatServiceError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AgentChatServiceError';
    this.statusCode = statusCode;
  }
}

function reference(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 20_000) {
    throw new AgentChatServiceError(`${label} must be a non-empty string of at most 20000 characters.`);
  }
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (/sk-|Bearer|ghp_|github_pat_|password|apiKey|privateKey/i.test(text)) {
    throw new AgentChatServiceError(`${label} contains secret-like content.`);
  }
  return text;
}

function boundedOutput(value: string | null): string {
  const text = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 12_000) : '模型未返回内容。';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function terminalState(state: TaskSnapshot['state']): boolean {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
}

function taskStateToMessageState(task: TaskSnapshot): AgentChatMessageState {
  if (task.state === 'succeeded') return 'succeeded';
  if (task.state === 'failed' || task.state === 'interrupted') return 'failed';
  if (task.state === 'cancelled') return 'cancelled';
  return 'pending';
}

export class AgentChatService {
  private readonly conversations = new Map<string, ConversationRecord>();

  constructor(private readonly taskService: TaskService) {}

  listAgents(): readonly AgentChatAgentView[] {
    return Object.freeze(this.taskService.listAgents().map((agent) => Object.freeze({
      id: agent.id,
      name: agent.current.name,
      currentRevisionId: agent.currentRevisionId,
      providerId: agent.current.providerId,
      modelId: agent.current.modelId,
      isDefault: agent.isDefault,
      archived: agent.archived,
    })));
  }

  createConversation(input: unknown): AgentChatConversationView {
    if (!isRecord(input)) throw new AgentChatServiceError('Conversation input must be an object.');
    const allowed = new Set(['agentId']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new AgentChatServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
    const agentId = input.agentId === undefined
      ? this.defaultAgentId()
      : boundedText(input.agentId, 'agentId');
    const agent = this.getUsableAgent(agentId);
    const id = reference('chat', `${agent.id}:${agent.currentRevisionId}:${randomUUID()}`);
    const record: ConversationRecord = {
      id,
      agentId: agent.id,
      agentRevisionId: agent.currentRevisionId,
      providerId: agent.current.providerId,
      modelId: agent.current.modelId,
      configurationRevisionId: this.taskService.activeConfigurationRevisionId,
      messages: [],
      idempotency: new Map(),
    };
    this.conversations.set(id, record);
    return this.view(id);
  }

  async postMessage(conversationId: string, input: unknown): Promise<AgentChatMessageResult> {
    const record = this.conversations.get(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    if (!isRecord(input)) throw new AgentChatServiceError('Message input must be an object.');
    const allowed = new Set(['text', 'idempotencyKey']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new AgentChatServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
    const text = boundedText(input.text, 'text').slice(0, 6000);
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotencyKey').slice(0, 200);
    const replayKey = record.idempotency.get(idempotencyKey);
    if (replayKey) {
      const replayedUser = record.messages.find((message) => message.id === replayKey);
      const replayedAssistant = replayedUser
        ? record.messages.find((message) => message.taskId !== null
          && message.sequence === replayedUser.sequence + 1)
        : undefined;
      if (replayedUser && replayedAssistant) {
        return Object.freeze({
          version: AGENT_CHAT_CONTRACT_VERSION,
          conversationId,
          userMessage: replayedUser,
          assistantMessage: replayedAssistant,
        });
      }
    }

    const context = record.messages.slice(-8).map((message) =>
      `${message.author === 'user' ? 'User' : 'Assistant'}: ${message.body}`).join('\n');
    const prompt = context.length > 0 ? `${context}\n\nUser: ${text}` : text;
    let task: TaskSnapshot;
    try {
      task = await this.taskService.createAgentTask({
        prompt,
        agentId: record.agentId,
        expectedAgentRevisionId: record.agentRevisionId,
      });
    } catch (cause) {
      throw new AgentChatServiceError(
        cause instanceof Error ? cause.message.slice(0, 240) : 'Agent task creation failed.',
        cause instanceof Error && cause.name.includes('NotFound') ? 404 : 409,
      );
    }
    const userMessage: AgentChatMessage = Object.freeze({
      id: reference('amsg', `${conversationId}:${task.id}:user`),
      sequence: record.messages.length + 1,
      author: 'user',
      body: text,
      state: 'published',
      taskId: null,
      error: null,
    });
    const assistantMessage: AgentChatMessage = Object.freeze({
      id: reference('amsg', `${conversationId}:${task.id}:assistant`),
      sequence: record.messages.length + 2,
      author: 'assistant',
      body: '',
      state: 'pending',
      taskId: task.id,
      error: null,
    });
    record.messages.push(userMessage, assistantMessage);
    record.idempotency.set(idempotencyKey, userMessage.id);
    try {
      this.taskService.startTask(task.id);
    } catch (cause) {
      this.replaceMessage(record, assistantMessage.id, {
        ...assistantMessage,
        body: 'Runtime could not start the Agent task.',
        state: 'failed',
        error: cause instanceof Error ? cause.message.slice(0, 240) : 'Task start failed.',
      });
    }
    this.refreshConversation(record);
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      userMessage,
      assistantMessage: this.getMessage(record, assistantMessage.id)!,
    });
  }

  view(conversationId: string): AgentChatConversationView {
    const record = this.conversations.get(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    this.refreshConversation(record);
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      id: record.id,
      agentId: record.agentId,
      agentRevisionId: record.agentRevisionId,
      providerId: record.providerId,
      modelId: record.modelId,
      configurationRevisionId: record.configurationRevisionId,
      messages: Object.freeze(record.messages.map((message) => Object.freeze({ ...message }))),
    });
  }

  private defaultAgentId(): string {
    const defaultAgent = this.taskService.listAgents().find((agent) => agent.isDefault && !agent.archived);
    if (defaultAgent) return defaultAgent.id;
    const first = this.taskService.listAgents().find((agent) => !agent.archived);
    if (first) return first.id;
    throw new AgentChatServiceError('No configured Agent is available.', 503);
  }

  private getUsableAgent(agentId: string): AgentDetail {
    let agent: AgentDetail;
    try {
      agent = this.taskService.getAgent(agentId);
    } catch {
      throw new AgentChatServiceError('Configured Agent not found.', 404);
    }
    if (agent.archived) throw new AgentChatServiceError('Archived Agents cannot start a chat.', 409);
    return agent;
  }

  private refreshConversation(record: ConversationRecord): void {
    for (const message of record.messages) {
      if (message.author !== 'assistant' || message.taskId === null || message.state !== 'pending') continue;
      const task = this.taskService.store.getTask(message.taskId);
      if (!task) {
        this.replaceMessage(record, message.id, {
          ...message,
          body: 'Agent task is unavailable.',
          state: 'failed',
          error: 'Task not found.',
        });
        continue;
      }
      if (!terminalState(task.state)) {
        if (task.partialOutput && task.partialOutput.length > 0) {
          this.replaceMessage(record, message.id, {
            ...message,
            body: boundedOutput(task.partialOutput),
          });
        }
        continue;
      }
      const state = taskStateToMessageState(task);
      this.replaceMessage(record, message.id, {
        ...message,
        body: state === 'succeeded'
          ? boundedOutput(task.output)
          : state === 'failed'
            ? '模型调用失败。'
            : '回复已取消。',
        state,
        error: state === 'failed' ? (task.error ?? 'Agent task failed.').slice(0, 500) : null,
      });
    }
  }

  private getMessage(record: ConversationRecord, messageId: string): AgentChatMessage | undefined {
    return record.messages.find((message) => message.id === messageId);
  }

  private replaceMessage(record: ConversationRecord, messageId: string, next: AgentChatMessage): void {
    const index = record.messages.findIndex((message) => message.id === messageId);
    if (index >= 0) record.messages[index] = Object.freeze(next);
  }
}
