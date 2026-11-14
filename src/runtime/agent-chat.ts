import { createHash, randomUUID } from 'node:crypto';
import type { AgentDetail } from './agent-profile.js';
import type { TaskService } from './task-service.js';
import { TaskConflictError, TaskNotFoundError } from './task-store.js';
import type { TaskSnapshot } from './task-store.js';
import { chineseAgentDisplayName } from './agent-name.js';
import type { BossModeService } from './boss-mode-service.js';
import { containsSecretLike } from './secret-filter.js';
import {
  InMemoryAgentChatStore,
  type AgentChatConversationRecord,
  type AgentChatStore,
} from './agent-chat-store.js';

export const AGENT_CHAT_CONTRACT_VERSION = '1.8.0';

export const AGENT_CHAT_PUBLIC_PATHS = Object.freeze([
  '/v1/agent-chat/agents',
  '/v1/agent-chat/conversations',
  '/v1/agent-chat/conversations/{conversationId}',
  '/v1/agent-chat/conversations/{conversationId}/messages',
  '/v1/agent-chat/conversations/{conversationId}/approval',
  '/v1/agent-chat/conversations/{conversationId}/events',
] as const);

export const AGENT_CHAT_PUBLIC_PATH_COUNT = AGENT_CHAT_PUBLIC_PATHS.length;

export const BOSS_AGENT_ID = 'boss-agent';
export const BOSS_AGENT_NAME = '老板 Agent';
export const BOSS_AGENT_REVISION_ID = 'boss-runtime-v1';
export const BOSS_AGENT_PROVIDER_ID = 'runtime';
export const BOSS_AGENT_MODEL_ID = '组织编排';

export type AgentChatMessageAuthor = 'user' | 'assistant' | 'runtime';
export type AgentChatMessageState =
  | 'published'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'thinking'
  | 'streaming'
  | 'organizing'
  | 'waiting_approval'
  | 'waiting_attention'
  | 'replied'
  | 'unavailable';

export type AgentChatMessagePhase =
  | 'accepted'
  | 'preparing'
  | 'model'
  | 'organization'
  | 'human'
  | 'terminal';

export type AgentChatReasoningEffort = 'low' | 'medium' | 'high';

export type AgentChatActivityKind = 'turn' | 'tool' | 'approval' | 'output';
export type AgentChatActivityState = 'running' | 'succeeded' | 'failed' | 'waiting_approval';

export interface AgentChatActivity {
  readonly id: string;
  readonly kind: AgentChatActivityKind;
  readonly label: string;
  readonly state: AgentChatActivityState;
  readonly detail: string | null;
}

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
  readonly phase: AgentChatMessagePhase;
  readonly progress: number | null;
  readonly updatedAt: string;
  readonly replyToId: string | null;
  readonly activity: readonly AgentChatActivity[];
}

const NONTERMINAL_STATES: readonly AgentChatMessageState[] = Object.freeze([
  'pending', 'thinking', 'streaming', 'organizing', 'waiting_approval',
]);

export interface AgentChatConversationView {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly id: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configurationRevisionId: string;
  readonly reasoningEffort: AgentChatReasoningEffort;
  readonly messages: readonly AgentChatMessage[];
}

export interface AgentChatConversationSummary {
  readonly id: string;
  readonly agentId: string;
  readonly reasoningEffort: AgentChatReasoningEffort;
  readonly createdAt: string;
  readonly messageCount: number;
  readonly lastMessagePreview: string;
}

export interface AgentChatConversationList {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversations: readonly AgentChatConversationSummary[];
  readonly defaultModelId: string | null;
}

export interface AgentChatMessageResult {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversationId: string;
  readonly userMessage: AgentChatMessage;
  readonly assistantMessage: AgentChatMessage;
}

export interface AgentChatApprovalResult {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversationId: string;
  readonly assistantMessage: AgentChatMessage;
}

export interface AgentChatStreamFrame {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversationId: string;
  readonly kind: 'snapshot' | 'message';
  readonly eventId: string | null;
  readonly messageId: string | null;
  readonly message: AgentChatMessage | null;
  readonly conversation: AgentChatConversationView | null;
}

interface ConversationRecord extends Omit<AgentChatConversationRecord, 'idempotency'> {
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
  if (containsSecretLike(text)) {
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

function terminalTaskState(state: TaskSnapshot['state']): boolean {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
}

function nonterminalMessageState(state: AgentChatMessageState): boolean {
  return NONTERMINAL_STATES.includes(state);
}

function taskStateToMessageState(task: TaskSnapshot): AgentChatMessageState {
  if (task.state === 'succeeded') return 'replied';
  if (task.state === 'failed' || task.state === 'interrupted') return 'failed';
  if (task.state === 'cancelled') return 'cancelled';
  if (task.state === 'waiting_approval') return 'waiting_approval';
  return task.partialOutput && task.partialOutput.length > 0 ? 'streaming' : 'thinking';
}

function unavailableError(message: string | null): boolean {
  return /model catalog is unavailable|provider model catalog is unavailable|upstream|not valid JSON|empty completion|invalid JSON|not bounded|unknown fields|secret-like|selected model is not available/i.test(message ?? '');
}

function unavailableBody(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : '';
  if (/HTTP 429|rate limit/i.test(text)) return '模型服务当前请求过多，请稍后重试。';
  if (/HTTP 5\d\d|upstream/i.test(text)) return '模型服务暂不可用，请检查 Magpie 配置或稍后重试。';
  if (/not valid JSON|invalid JSON|not bounded|unknown fields|empty completion/i.test(text)) {
    return '模型返回格式不符合 Runtime 契约，本次回复未采用。';
  }
  if (/secret-like/i.test(text)) return '模型返回包含敏感内容，本次回复已拒绝。';
  return '模型目录暂不可用，请检查 Magpie 配置。';
}

function phaseForState(state: AgentChatMessageState): AgentChatMessagePhase {
  if (state === 'thinking' || state === 'streaming' || state === 'pending') return 'preparing';
  if (state === 'organizing') return 'organization';
  if (state === 'waiting_attention' || state === 'waiting_approval') return 'human';
  if (state === 'replied' || state === 'failed' || state === 'cancelled' || state === 'unavailable' || state === 'succeeded') return 'terminal';
  return 'accepted';
}

function parseReasoningEffort(value: unknown): AgentChatReasoningEffort {
  if (value === undefined) return 'medium';
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new AgentChatServiceError('reasoningEffort must be low, medium, or high.');
}

function message(
  input: Omit<AgentChatMessage, 'phase' | 'progress' | 'updatedAt' | 'replyToId' | 'activity'>
    & Partial<Pick<AgentChatMessage, 'phase' | 'progress' | 'updatedAt' | 'replyToId' | 'activity'>>,
  now = () => new Date().toISOString(),
): AgentChatMessage {
  return Object.freeze({
    phase: phaseForState(input.state),
    progress: null,
    updatedAt: now(),
    replyToId: null,
    activity: Object.freeze([]),
    ...input,
  });
}

const MAX_ACTIVITY = 8;

function toolLabel(toolId: string): string {
  const known: Readonly<Record<string, string>> = Object.freeze({
    workspace_list: '查看工作区',
    workspace_read: '读取文件',
    workspace_write: '写入文件',
  });
  return known[toolId] ?? '调用工具';
}

function boundedString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 200) : fallback;
}

export class AgentChatService {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly store: AgentChatStore;

  constructor(
    readonly taskService: TaskService,
    private readonly bossMode?: BossModeService,
    private readonly now: () => string = () => new Date().toISOString(),
    store?: AgentChatStore,
  ) {
    this.store = store ?? taskService.store?.agentChat ?? new InMemoryAgentChatStore();
    this.store.initialize();
  }

  listAgents(): readonly AgentChatAgentView[] {
    const configured = this.taskService.listAgents().map((agent) => Object.freeze({
      id: agent.id,
      name: chineseAgentDisplayName(agent.current.name),
      currentRevisionId: agent.currentRevisionId,
      providerId: agent.current.providerId,
      modelId: agent.current.modelId,
      isDefault: agent.isDefault,
      archived: agent.archived,
    }));
    const boss = this.bossMode ? this.bossAgentView() : null;
    return Object.freeze(boss ? [boss, ...configured] : configured);
  }

  async createConversation(input: unknown): Promise<AgentChatConversationView> {
    if (!isRecord(input)) throw new AgentChatServiceError('Conversation input must be an object.');
    const allowed = new Set(['agentId', 'modelOverride', 'reasoningEffort']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new AgentChatServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
    const agentId = input.agentId === undefined
      ? this.defaultAgentId()
      : boundedText(input.agentId, 'agentId');
    const modelOverride = this.parseModelOverride(input.modelOverride);
    const reasoningEffort = parseReasoningEffort(input.reasoningEffort);
    const isBoss = agentId === BOSS_AGENT_ID;
    if (isBoss && !this.bossMode) throw new AgentChatServiceError('Boss Agent is not configured.', 503);
    const bossView = isBoss ? this.bossAgentView() : null;
    const agentDetail = bossView ? undefined : this.getUsableAgent(agentId);
    const agent = bossView ?? {
      id: agentDetail!.id,
      currentRevisionId: agentDetail!.currentRevisionId,
      providerId: agentDetail!.current.providerId,
      modelId: agentDetail!.current.modelId,
    };
    if (modelOverride) {
      try {
        await this.taskService.validateModelReference(modelOverride);
      } catch (cause) {
        throw new AgentChatServiceError(
          cause instanceof Error ? cause.message.slice(0, 240) : 'Model override is not available.',
          400,
        );
      }
    }
    const id = reference('chat', `${agent.id}:${agent.currentRevisionId}:${randomUUID()}`);
    const record: ConversationRecord = {
      id,
      agentId: isBoss ? BOSS_AGENT_ID : agent.id,
      agentRevisionId: agent.currentRevisionId,
      providerId: modelOverride?.providerId ?? agent.providerId,
      modelId: modelOverride?.modelId ?? agent.modelId,
      configurationRevisionId: this.taskService.activeConfigurationRevisionId,
      isBoss,
      reasoningEffort,
      createdAt: this.now(),
      messages: [],
      idempotency: new Map(),
    };
    this.conversations.set(id, record);
    this.persist(record);
    return this.view(id);
  }

  private parseModelOverride(value: unknown): { providerId: string; modelId: string } | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new AgentChatServiceError('modelOverride must contain providerId and modelId.');
    if (typeof value.providerId !== 'string' || typeof value.modelId !== 'string') {
      throw new AgentChatServiceError('modelOverride must contain providerId and modelId.');
    }
    return Object.freeze({
      providerId: value.providerId,
      modelId: value.modelId,
    });
  }

  async postMessage(conversationId: string, input: unknown): Promise<AgentChatMessageResult> {
    const record = this.load(conversationId);
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
        ? record.messages.find((message) => message.author === 'assistant'
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

    if (record.isBoss) return this.postBossMessage(record, text, idempotencyKey);
    const context = record.messages.slice(-8).map((message) =>
      `${message.author === 'user' ? 'User' : 'Assistant'}: ${message.body}`).join('\n');
    const prompt = context.length > 0 ? `${context}\n\nUser: ${text}` : text;
    let task: TaskSnapshot;
    try {
      task = await this.taskService.createAgentTaskWithEffort({
        prompt,
        agentId: record.agentId,
        expectedAgentRevisionId: record.agentRevisionId,
        modelOverride: { providerId: record.providerId, modelId: record.modelId },
      }, record.reasoningEffort);
    } catch (cause) {
      const errorText = cause instanceof Error ? cause.message.slice(0, 240) : 'Agent task creation failed.';
      if (cause instanceof Error && cause.name.includes('NotFound')) {
        throw new AgentChatServiceError(errorText, 404);
      }
      const userMessage = message({
        id: reference('amsg', `${record.id}:${idempotencyKey}:failed-user`),
        sequence: record.messages.length + 1,
        author: 'user',
        body: text,
        state: 'published',
        taskId: null,
        error: null,
        phase: 'accepted',
        updatedAt: this.now(),
      }, this.now);
      const assistantMessage = message({
        id: reference('amsg', `${record.id}:${idempotencyKey}:failed-assistant`),
        sequence: record.messages.length + 2,
        author: 'assistant',
        body: unavailableError(errorText)
          ? '模型目录暂不可用，请检查 Magpie 配置。'
          : 'Agent 任务创建失败。',
        state: unavailableError(errorText) ? 'unavailable' : 'failed',
        taskId: null,
        error: errorText,
        phase: 'terminal',
        replyToId: userMessage.id,
        updatedAt: this.now(),
      }, this.now);
      record.messages.push(userMessage, assistantMessage);
      record.idempotency.set(idempotencyKey, userMessage.id);
      this.persist(record);
      return Object.freeze({
        version: AGENT_CHAT_CONTRACT_VERSION,
        conversationId: record.id,
        userMessage,
        assistantMessage,
      });
    }
    const userMessage = message({
      id: reference('amsg', `${conversationId}:${task.id}:user`),
      sequence: record.messages.length + 1,
      author: 'user',
      body: text,
      state: 'published',
      taskId: null,
      error: null,
      phase: 'accepted',
      updatedAt: this.now(),
    }, this.now);
    const assistantMessage = message({
      id: reference('amsg', `${conversationId}:${task.id}:assistant`),
      sequence: record.messages.length + 2,
      author: 'assistant',
      body: '',
      state: 'thinking',
      taskId: task.id,
      error: null,
      phase: 'preparing',
      replyToId: userMessage.id,
      updatedAt: this.now(),
    }, this.now);
    record.messages.push(userMessage, assistantMessage);
    record.idempotency.set(idempotencyKey, userMessage.id);
    this.persist(record);
    try {
      this.taskService.startTask(task.id);
    } catch (cause) {
      this.replaceMessage(record, assistantMessage.id, {
        ...assistantMessage,
        body: 'Runtime 无法启动 Agent 任务。',
        state: 'failed',
        error: cause instanceof Error ? cause.message.slice(0, 240) : 'Task start failed.',
        updatedAt: this.now(),
      });
      this.persist(record);
    }
    this.refreshConversation(record);
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      userMessage,
      assistantMessage: this.getMessage(record, assistantMessage.id)!,
    });
  }

  decideApproval(conversationId: string, input: unknown): AgentChatApprovalResult {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    if (!isRecord(input)) throw new AgentChatServiceError('Approval input must be an object.');
    const allowed = new Set(['assistantMessageId', 'decision']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new AgentChatServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new AgentChatServiceError('decision must be approved or rejected.');
    }
    if (input.assistantMessageId === undefined) {
      throw new AgentChatServiceError('assistantMessageId is required.');
    }
    const assistantMessageId = boundedText(input.assistantMessageId, 'assistantMessageId');
    const assistant = record.messages.find((entry) => entry.id === assistantMessageId);
    if (!assistant || assistant.author !== 'assistant' || assistant.taskId === null) {
      throw new AgentChatServiceError('Assistant message has no pending Agent task.', 404);
    }
    if (record.isBoss) throw new AgentChatServiceError('Boss Agent does not use task approval.', 409);
    try {
      this.taskService.decideApproval(assistant.taskId, input.decision);
    } catch (cause) {
      if (cause instanceof TaskNotFoundError) {
        throw new AgentChatServiceError('Agent task not found.', 404);
      }
      if (cause instanceof TaskConflictError) {
        throw new AgentChatServiceError(cause.message, 409);
      }
      throw cause instanceof Error
        ? new AgentChatServiceError(cause.message.slice(0, 240), 400)
        : new AgentChatServiceError('Approval decision failed.');
    }
    this.refreshConversation(record);
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      assistantMessage: this.getMessage(record, assistant.id)!,
    });
  }

  view(conversationId: string): AgentChatConversationView {
    const record = this.load(conversationId);
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
      reasoningEffort: record.reasoningEffort,
      messages: Object.freeze(record.messages.map((message) => Object.freeze({ ...message }))),
    });
  }

  conversationTaskIds(conversationId: string): readonly string[] {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    return Object.freeze([...new Set(record.messages.flatMap((message) =>
      message.taskId === null ? [] : [message.taskId]))]);
  }

  snapshotFrame(conversationId: string, cursor: string | null): AgentChatStreamFrame {
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      kind: 'snapshot',
      eventId: cursor,
      messageId: null,
      message: null,
      conversation: this.view(conversationId),
    });
  }

  eventFrame(
    conversationId: string,
    eventId: string,
    taskId: string,
  ): AgentChatStreamFrame | null {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    this.refreshConversation(record);
    const message = record.messages.find((entry) => entry.taskId === taskId);
    if (!message) return null;
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      kind: 'message',
      eventId,
      messageId: message.id,
      message,
      conversation: null,
    });
  }

  async listConversations(limit = 20): Promise<AgentChatConversationList> {
    const bounded = Math.max(1, Math.min(limit, 50));
    const records = this.store.list(bounded);
    let defaultModelId: string | null = null;
    try {
      const models = await this.taskService.listProviderModels();
      const configured = this.taskService.preferredChatModelId;
      defaultModelId = (configured && models.some((model) => model.modelId === configured))
        ? configured
        : models[0]?.modelId ?? null;
    } catch {
      defaultModelId = null;
    }
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversations: Object.freeze(records.map((record) => {
        const last = [...record.messages].reverse().find((entry) => entry.body.length > 0);
        return Object.freeze({
          id: record.id,
          agentId: record.agentId,
          reasoningEffort: record.reasoningEffort,
          createdAt: record.createdAt,
          messageCount: record.messages.length,
          lastMessagePreview: (last?.body ?? '').slice(0, 120),
        });
      })),
      defaultModelId,
    });
  }

  private defaultAgentId(): string {
    if (this.bossMode) return BOSS_AGENT_ID;
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

  private bossAgentView(): AgentChatAgentView {
    return Object.freeze({
      id: BOSS_AGENT_ID,
      name: BOSS_AGENT_NAME,
      currentRevisionId: BOSS_AGENT_REVISION_ID,
      providerId: BOSS_AGENT_PROVIDER_ID,
      modelId: BOSS_AGENT_MODEL_ID,
      isDefault: false,
      archived: false,
    });
  }

  private async postBossMessage(
    record: ConversationRecord,
    text: string,
    idempotencyKey: string,
  ): Promise<AgentChatMessageResult> {
    const bossMode = this.bossMode;
    if (!bossMode) throw new AgentChatServiceError('Boss Agent is not configured.', 503);
    const conversation = record.messages.slice(-8).map((message) => ({
      author: message.author === 'user' ? 'user' as const : 'assistant' as const,
      body: message.body,
    }));
    const userMessage = message({
      id: reference('amsg', `${record.id}:${idempotencyKey}:user`),
      sequence: record.messages.length + 1,
      author: 'user',
      body: text,
      state: 'published',
      taskId: null,
      error: null,
      phase: 'accepted',
      updatedAt: this.now(),
    }, this.now);
    const assistantMessage = message({
      id: reference('amsg', `${record.id}:${idempotencyKey}:assistant`),
      sequence: record.messages.length + 2,
      author: 'assistant',
      body: '',
      state: 'thinking',
      taskId: null,
      error: null,
      phase: 'preparing',
      replyToId: userMessage.id,
      updatedAt: this.now(),
    }, this.now);
    record.messages.push(userMessage, assistantMessage);
    record.idempotency.set(idempotencyKey, userMessage.id);
    this.persist(record);
    const onAccepted = (submitted: Awaited<ReturnType<BossModeService['submit']>>) => {
      const waiting = submitted.relays.some((relay) => relay.kind === 'attention')
        || this.bossMode?.snapshot().attentionRequests.some((request) => request.state === 'open')
        || false;
      const failed = submitted.executions.some((execution) => execution.status === 'failed');
      this.replaceMessage(record, assistantMessage.id, {
        ...assistantMessage,
        body: submitted.reply ?? (failed
          ? 'Runtime 执行组织动作时失败。'
          : `已提交 ${submitted.actions.length} 个 Runtime 可验证动作。`),
        state: failed ? 'failed' : waiting ? 'waiting_attention' : 'replied',
        phase: waiting ? 'human' : 'terminal',
        error: failed ? 'Boss Agent execution failed.' : null,
        updatedAt: this.now(),
      });
      this.persist(record);
    };
    void bossMode.submit({
        text,
        idempotencyKey: `agent-chat:${record.id}:${idempotencyKey}`,
        conversation,
        reasoningEffort: record.reasoningEffort,
        ...(record.isBoss && record.providerId === 'runtime'
          ? {}
          : { modelOverride: { providerId: record.providerId, modelId: record.modelId } }),
        source: 'agent-chat' as const,
        onProgress: (progress: {
          readonly state: 'thinking' | 'streaming' | 'organizing';
          readonly percent: number | null;
          readonly previousText?: string;
        }) => {
          const current = this.getMessage(record, assistantMessage.id);
          if (!current || current.phase === 'terminal') return;
          this.replaceMessage(record, assistantMessage.id, {
            ...current,
            state: progress.state,
            phase: progress.state === 'organizing' ? 'organization' : 'model',
            body: progress.previousText ?? current.body,
            progress: progress.percent,
            updatedAt: this.now(),
          });
          this.persist(record);
        },
      }, onAccepted).catch((cause: unknown) => {
        const textError = cause instanceof Error ? cause.message.slice(0, 240) : 'Boss Agent submit failed.';
        this.replaceMessage(record, assistantMessage.id, {
          ...assistantMessage,
          body: unavailableError(textError) ? unavailableBody(cause) : '老板 Agent 提交失败。',
          state: unavailableError(textError) ? 'unavailable' : 'failed',
          phase: 'terminal',
          error: textError,
          updatedAt: this.now(),
        });
        this.persist(record);
      });
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId: record.id,
      userMessage,
      assistantMessage: this.getMessage(record, assistantMessage.id)!,
    });
  }

  private refreshConversation(record: ConversationRecord): void {
    let changed = false;
    for (const message of record.messages) {
      if (message.author !== 'assistant' || message.taskId === null || !nonterminalMessageState(message.state)) continue;
      const task = this.taskService.store.getTask(message.taskId);
      if (!task) {
        this.replaceMessage(record, message.id, {
          ...message,
          body: 'Agent 任务不可用。',
          state: 'failed',
          error: 'Task not found.',
          updatedAt: this.now(),
        });
        changed = true;
        continue;
      }
      if (!terminalTaskState(task.state)) {
        const state = taskStateToMessageState(task);
        const activity = this.taskActivity(task.id);
        if (task.partialOutput && task.partialOutput.length > 0) {
          this.replaceMessage(record, message.id, {
            ...message,
            body: boundedOutput(task.partialOutput),
            state,
            phase: 'model',
            progress: Math.min(100, Math.max(5, task.partialOutput.length)),
            updatedAt: this.now(),
            activity,
          });
          changed = true;
        } else if (message.state !== state || JSON.stringify(message.activity) !== JSON.stringify(activity)) {
          this.replaceMessage(record, message.id, {
            ...message,
            state,
            phase: phaseForState(state),
            updatedAt: this.now(),
            activity,
          });
          changed = true;
        }
        continue;
      }
      const state = taskStateToMessageState(task);
      const error = state === 'failed' ? (task.error ?? 'Agent task failed.').slice(0, 500) : null;
      const finalState = state === 'failed' && unavailableError(error) ? 'unavailable' : state;
      this.replaceMessage(record, message.id, {
        ...message,
        body: state === 'replied'
          ? boundedOutput(task.output)
          : state === 'failed'
            ? '模型调用失败。'
            : '回复已取消。',
        state: finalState,
        phase: 'terminal',
        progress: state === 'replied' ? 100 : null,
        error,
        updatedAt: this.now(),
        activity: this.taskActivity(task.id),
      });
      changed = true;
    }
    if (changed) this.persist(record);
  }

  private taskActivity(taskId: string): readonly AgentChatActivity[] {
    const events = this.taskService.store.listEvents(null).filter((event) => event.taskId === taskId);
    const activity: AgentChatActivity[] = [];
    let lastTurn: AgentChatActivity | null = null;
    const byTool = new Map<string, AgentChatActivity>();
    for (const event of events) {
      if (event.type === 'agent_loop.turn_started') {
        const iteration = typeof event.data.iteration === 'number' ? event.data.iteration : 0;
        const next: AgentChatActivity = Object.freeze({
          id: `turn-${iteration}`,
          kind: 'turn',
          label: `第 ${iteration + 1} 轮`,
          state: 'running',
          detail: null,
        });
        const index = activity.findIndex((entry) => entry.id === next.id);
        if (index >= 0) activity[index] = next;
        else activity.push(next);
        lastTurn = next;
      } else if (event.type === 'agent_loop.turn_completed') {
        if (lastTurn) {
          const completed: AgentChatActivity = Object.freeze({
            ...lastTurn,
            state: 'succeeded' as const,
          });
          const index = activity.findIndex((entry) => entry.id === lastTurn!.id);
          if (index >= 0) activity[index] = completed;
          lastTurn = completed;
        }
      } else if (event.type === 'agent_loop.tool_requested') {
        const toolId = boundedString(event.data.toolId, 'unknown');
        const key = `${event.id}:${toolId}`;
        const next: AgentChatActivity = Object.freeze({
          id: key,
          kind: 'tool',
          label: toolLabel(toolId),
          state: 'running',
          detail: toolId,
        });
        byTool.set(toolId, next);
        activity.push(next);
      } else if (event.type === 'agent_loop.tool_executed') {
        const toolId = boundedString(event.data.toolId, 'unknown');
        const current = byTool.get(toolId);
        if (current) {
          const done = Object.freeze({ ...current, state: 'succeeded' as const });
          const index = activity.findIndex((entry) => entry.id === current.id);
          if (index >= 0) activity[index] = done;
          byTool.delete(toolId);
        }
      } else if (event.type === 'agent_loop.tool_failed') {
        const toolId = boundedString(event.data.toolId, 'unknown');
        const current = byTool.get(toolId);
        const failed: AgentChatActivity = Object.freeze({
          id: current?.id ?? `${event.id}:${toolId}`,
          kind: 'tool',
          label: toolLabel(toolId),
          state: 'failed',
          detail: toolId,
        });
        if (current) {
          const index = activity.findIndex((entry) => entry.id === current.id);
          if (index >= 0) activity[index] = failed;
          else activity.push(failed);
        } else {
          activity.push(failed);
        }
        byTool.delete(toolId);
      } else if (event.type === 'agent_loop.approval_requested') {
        activity.push(Object.freeze({
          id: `approval-${event.id}`,
          kind: 'approval',
          label: '等待审批',
          state: 'waiting_approval',
          detail: null,
        }));
      } else if (event.type === 'agent_loop.approval_decided') {
        const index = [...activity].reverse().findIndex((entry) => entry.kind === 'approval'
          && entry.state === 'waiting_approval');
        if (index >= 0) {
          const target = activity.length - 1 - index;
          const entry = activity[target]!;
          activity[target] = Object.freeze({ ...entry, label: '审批已处理', state: 'succeeded' as const });
        }
      }
    }
    if (activity.length > MAX_ACTIVITY) return Object.freeze(activity.slice(-MAX_ACTIVITY));
    return Object.freeze(activity);
  }

  private getMessage(record: ConversationRecord, messageId: string): AgentChatMessage | undefined {
    return record.messages.find((message) => message.id === messageId);
  }

  private replaceMessage(record: ConversationRecord, messageId: string, next: AgentChatMessage): void {
    const index = record.messages.findIndex((message) => message.id === messageId);
    if (index >= 0) record.messages[index] = Object.freeze(next);
  }

  private load(conversationId: string): ConversationRecord | null {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const stored = this.store.get(conversationId);
    if (!stored) return null;
    const record: ConversationRecord = {
      ...stored,
      messages: [...stored.messages],
      idempotency: new Map(stored.idempotency),
    };
    this.conversations.set(conversationId, record);
    return record;
  }

  private persist(record: ConversationRecord): void {
    this.store.save({
      ...record,
      messages: Object.freeze([...record.messages]),
      idempotency: Object.freeze([...record.idempotency.entries()].map(([key, value]) =>
        Object.freeze([key, value] as const))),
    });
  }
}
