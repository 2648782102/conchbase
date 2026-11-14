import { createHash } from 'node:crypto';
import type { OrganizationEvent, OrganizationSnapshot } from './organization-contract.js';
import { chineseAgentDisplayName } from './agent-name.js';

export const PRIMARY_CONVERSATION_CONTRACT_VERSION = '1.4.0';

export const PRIMARY_CONVERSATION_PUBLIC_PATHS = Object.freeze([
  '/v1/organization/conversation',
  '/v1/organization/conversation/messages',
] as const);

export const PRIMARY_CONVERSATION_PUBLIC_PATH_COUNT = PRIMARY_CONVERSATION_PUBLIC_PATHS.length;

export type ConversationMessageKind =
  | 'user_message'
  | 'boss_acknowledgement'
  | 'worker_activity'
  | 'report'
  | 'attention'
  | 'system_status';

export type ConversationMessageAuthor = 'user' | 'boss' | 'worker' | 'runtime';

export type ConversationMessageState =
  | 'published'
  | 'open'
  | 'answered'
  | 'withdrawn'
  | 'attention'
  | 'ready'
  | 'failed'
  | 'running'
  | 'succeeded';

export interface PrimaryConversationView {
  readonly version: typeof PRIMARY_CONVERSATION_CONTRACT_VERSION;
  readonly bossSessionId: string;
  readonly messageCount: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly messages: readonly ConversationMessage[];
}

export interface ConversationMessagePage {
  readonly version: typeof PRIMARY_CONVERSATION_CONTRACT_VERSION;
  readonly messages: readonly ConversationMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ConversationMessage {
  readonly version: typeof PRIMARY_CONVERSATION_CONTRACT_VERSION;
  readonly id: string;
  readonly sequence: number;
  readonly kind: ConversationMessageKind;
  readonly author: ConversationMessageAuthor;
  readonly body: string;
  readonly state: ConversationMessageState;
  readonly createdByEventId: string;
  readonly projectId: string | null;
  readonly workerId: string | null;
  readonly reportId: string | null;
  readonly attentionId: string | null;
  readonly expectedVersion: number | null;
}

export interface ConversationTaskState {
  readonly taskId: string;
  readonly state: string;
  readonly attempt: number;
}

export interface PrimaryConversationProjectionInput {
  readonly snapshot: OrganizationSnapshot;
  readonly intentTexts?: ReadonlyMap<string, string>;
  readonly taskStates?: readonly ConversationTaskState[];
  readonly limit?: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

function digest(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function boundedText(value: string | undefined, fallback: string): string {
  const candidate = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const bounded = candidate.length > 0 ? candidate.slice(0, 600) : fallback;
  if (/sk-|Bearer|ghp_|github_pat_|password|apiKey|privateKey|\.conchbase\//i.test(bounded)) return fallback;
  return bounded;
}

function limitFor(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error('Conversation limit must be an integer between 1 and 200.');
  }
  return value;
}

function messageForEvent(
  event: OrganizationEvent,
  snapshot: OrganizationSnapshot,
  intentTexts: ReadonlyMap<string, string> | undefined,
): ConversationMessage | null {
  const intentId = typeof event.data.intentId === 'string' ? event.data.intentId : null;
  const workerId = typeof event.data.workerId === 'string' ? event.data.workerId : null;
  const reportId = typeof event.data.reportId === 'string' ? event.data.reportId : null;
  const attentionId = typeof event.data.attentionId === 'string' ? event.data.attentionId : null;
  const base = {
    version: PRIMARY_CONVERSATION_CONTRACT_VERSION,
    id: digest('msg', `${event.id}:${event.type}`),
    sequence: event.sequence,
    createdByEventId: event.id,
    projectId: event.projectId,
    workerId,
    reportId,
    attentionId,
  } as const;

  if (event.type === 'organization.intent_recorded') {
    return Object.freeze({
      ...base,
      kind: 'user_message',
      author: 'user',
      body: boundedText(intentTexts?.get(intentId ?? ''), '用户意图已提交；原始文本仅在本 Runtime 进程内保留。'),
      state: 'published',
      expectedVersion: null,
    });
  }
  if (event.type === 'organization.project_activated') {
    return Object.freeze({
      ...base,
      kind: 'boss_acknowledgement',
      author: 'boss',
      body: '已收到意图，并由 Runtime 建立或激活项目。',
      state: 'published',
      expectedVersion: null,
    });
  }
  if (event.type === 'organization.agent_proposed') {
    const worker = snapshot.workers.find((item) => item.id === workerId);
    return Object.freeze({
      ...base,
      kind: 'worker_activity',
      author: 'boss',
      body: `已招聘员工${worker ? ` ${chineseAgentDisplayName(worker.displayName)}` : ''}，等待 Runtime 授权。`,
      state: 'published',
      expectedVersion: null,
    });
  }
  if (event.type === 'organization.worker_started') {
    const worker = snapshot.workers.find((item) => item.id === workerId);
    return Object.freeze({
      ...base,
      kind: 'worker_activity',
      author: 'worker',
      body: `员工${worker ? ` ${chineseAgentDisplayName(worker.displayName)}` : ''}已开始处理工作。`,
      state: 'running',
      expectedVersion: null,
    });
  }
  if (event.type === 'organization.report_recorded') {
    const report = snapshot.reports.find((item) => item.id === reportId);
    const state: ConversationMessageState = report?.state === 'failed' ? 'failed'
      : report?.state === 'attention' ? 'attention'
        : 'ready';
    return Object.freeze({
      ...base,
      kind: 'report',
      author: 'worker',
      body: state === 'failed' ? '员工报告：工作失败，请查看项目详情。'
        : state === 'attention' ? '员工报告：需要人工输入。'
          : '员工已提交结构化结果。',
      state,
      expectedVersion: null,
    });
  }
  if (event.type === 'organization.attention_requested') {
    const attention = snapshot.attentionRequests.find((item) => item.id === attentionId);
    return Object.freeze({
      ...base,
      kind: 'attention',
      author: 'boss',
      body: '老板 Agent 需要你确认一个开放问题。',
      state: 'open',
      expectedVersion: attention ? organizationAttentionVersion(attention.sequence) : null,
    });
  }
  if (event.type === 'organization.attention_answered' || event.type === 'organization.attention_withdrawn') {
    return Object.freeze({
      ...base,
      kind: 'attention',
      author: 'user',
      body: event.type === 'organization.attention_answered' ? '你已回答该问题。' : '你已撤回该问题。',
      state: event.type === 'organization.attention_answered' ? 'answered' : 'withdrawn',
      expectedVersion: null,
    });
  }
  if (event.type === 'organization.project_archived' || event.type === 'organization.project_resumed') {
    return Object.freeze({
      ...base,
      kind: 'boss_acknowledgement',
      author: 'boss',
      body: event.type === 'organization.project_archived' ? '项目已归档，相关活跃授权已撤销。' : '项目已重新验证并恢复。',
      state: 'published',
      expectedVersion: null,
    });
  }
  return null;
}

function organizationAttentionVersion(sequence: number): number {
  return sequence;
}

export function projectPrimaryConversation(
  input: PrimaryConversationProjectionInput,
): readonly ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const seen = new Set<string>();
  for (const event of input.snapshot.events) {
    const projected = messageForEvent(event, input.snapshot, input.intentTexts);
    if (!projected || seen.has(projected.id)) continue;
    seen.add(projected.id);
    messages.push(projected);
  }
  for (const [index, task] of (input.taskStates ?? []).entries()) {
    const linked = input.snapshot.events.find((event) => event.type === 'organization.worker_execution_recorded'
      && event.data.taskId === task.taskId);
    if (!linked) continue;
    const id = digest('msg', `task:${task.taskId}:${task.state}:${task.attempt}:${index}`);
    if (seen.has(id)) continue;
    seen.add(id);
    messages.push(Object.freeze({
      version: PRIMARY_CONVERSATION_CONTRACT_VERSION,
      id,
      sequence: linked.sequence,
      kind: 'system_status',
      author: 'runtime',
      body: task.state === 'running' ? '员工任务正在执行。'
        : task.state === 'succeeded' ? '员工任务已完成。'
          : task.state === 'failed' ? '员工任务失败。'
            : `员工任务状态：${task.state}。`,
      state: task.state === 'succeeded' ? 'succeeded'
        : task.state === 'failed' ? 'failed'
          : 'running',
      createdByEventId: linked.id,
      projectId: linked.projectId,
      workerId: typeof linked.data.workerId === 'string' ? linked.data.workerId : null,
      reportId: null,
      attentionId: null,
      expectedVersion: null,
    }));
  }
  return Object.freeze(messages.sort((left, right) =>
    left.sequence - right.sequence || left.id.localeCompare(right.id)));
}

export function primaryConversationView(input: PrimaryConversationProjectionInput): PrimaryConversationView {
  const limit = limitFor(input.limit);
  const all = projectPrimaryConversation(input);
  const messages = all.slice(-limit);
  return Object.freeze({
    version: PRIMARY_CONVERSATION_CONTRACT_VERSION,
    bossSessionId: input.snapshot.bossSession.id,
    messageCount: all.length,
    nextCursor: messages.at(-1)?.id ?? null,
    hasMore: all.length > messages.length,
    messages: Object.freeze(messages),
  });
}

export function primaryConversationPage(
  input: PrimaryConversationProjectionInput & { readonly after?: string | null },
): ConversationMessagePage {
  const limit = limitFor(input.limit);
  const all = projectPrimaryConversation(input);
  if (input.after !== undefined && input.after !== null
    && !all.some((message) => message.id === input.after)) {
    throw new Error('Conversation cursor is unknown.');
  }
  const start = input.after === undefined || input.after === null
    ? 0
    : all.findIndex((message) => message.id === input.after) + 1;
  const messages = all.slice(start, start + limit);
  return Object.freeze({
    version: PRIMARY_CONVERSATION_CONTRACT_VERSION,
    messages: Object.freeze(messages),
    nextCursor: messages.at(-1)?.id ?? null,
    hasMore: start + messages.length < all.length,
  });
}

export class PrimaryConversationService {
  private readonly intentTexts = new Map<string, string>();

  intentTextsView(): ReadonlyMap<string, string> {
    return this.intentTexts;
  }

  recordIntentText(intentId: string, text: string): void {
    const bounded = boundedText(text, '用户意图已提交。');
    this.intentTexts.set(intentId, bounded);
    if (this.intentTexts.size > 1000) {
      const oldest = this.intentTexts.keys().next();
      if (!oldest.done) this.intentTexts.delete(oldest.value);
    }
  }

  view(
    snapshot: OrganizationSnapshot,
    options: { limit?: number; taskStates?: readonly ConversationTaskState[] } = {},
  ): PrimaryConversationView {
    return primaryConversationView({
      snapshot,
      intentTexts: this.intentTexts,
      taskStates: options.taskStates ?? [],
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  page(
    snapshot: OrganizationSnapshot,
    options: {
      after?: string | null;
      limit?: number;
      taskStates?: readonly ConversationTaskState[];
    } = {},
  ): ConversationMessagePage {
    return primaryConversationPage({
      snapshot,
      intentTexts: this.intentTexts,
      taskStates: options.taskStates ?? [],
      ...options,
    });
  }
}
