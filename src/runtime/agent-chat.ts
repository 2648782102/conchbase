import { referenceDigest } from './digest.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentDetail } from './agent-profile.js';
import type { TaskService } from './task-service.js';
import { agUiEventType } from './ag-ui-events.js';
import { boundedOutput } from './agent-chat-output.js';
import { TaskConflictError, TaskNotFoundError } from './task-store.js';
import type { TaskSnapshot } from './task-store.js';
import { chineseAgentDisplayName } from './agent-name.js';
import { isPermissionLevel, narrowPermissionLevel, type PermissionLevel } from '../kernel/policy.js';
import type { BossModeService } from './boss-mode-service.js';
import {
  AgentChatMemory,
  type MemoryProposer,
} from './agent-chat-memory.js';
import {
  AttachmentError,
  parseAttachments,
  type Attachment,
  type ImageAttachment,
  type TextAttachment,
} from './attachments.js';
import { projectMessage } from './agent-chat-projection.js';
import { isTerminalTaskState } from './task-lifecycle.js';
import { containsSecretLike } from './secret-filter.js';
import { safeTaskError } from './error-categories.js';
import {
  NONTERMINAL_STATES,
  phaseForState,
  terminalMessageState,
  taskStateToMessageState,
  terminalTaskState,
  unavailableBody,
  unavailableError,
} from './agent-chat-state.js';
import {
  defaultEffort,
  parseEffortToken,
  sortEfforts,
} from './reasoning-effort.js';
import type {
  AgentChatActivity,
  AgentChatMessage,
  AgentChatMessageState,
  AgentChatReasoningEffort,
} from './agent-chat-types.js';

export type {
  AgentChatActivity,
  AgentChatActivityKind,
  AgentChatActivityState,
  AgentChatMessageAuthor,
  AgentChatMessagePhase,
  AgentChatMessageState,
  AgentChatMessage,
  AgentChatReasoningEffort,
} from './agent-chat-types.js';
import {
  InMemoryAgentChatStore,
  type AgentChatConversationRecord,
  type AgentChatStore,
} from './agent-chat-store.js';

export const AGENT_CHAT_CONTRACT_VERSION = '1.9.0';

/**
 * The fields `POST …/messages` accepts.
 *
 * Exported so the contract test can compare it against `AgentChatMessageRequest`
 * in `docs/openapi.yaml`. The last time this list grew, the implementation and
 * the document drifted: the new fields worked, but a client generated from the
 * spec was told they did not exist. A named list turns that into a test failure.
 */
export const AGENT_CHAT_MESSAGE_REQUEST_FIELDS = Object.freeze([
  'text',
  'idempotencyKey',
  'attachments',
  'reasoningEffort',
  'modelOverride',
]);

export const AGENT_CHAT_PUBLIC_PATHS = Object.freeze([
  '/v1/agent-chat/agents',
  '/v1/agent-chat/conversations',
  '/v1/agent-chat/conversations/{conversationId}',
  '/v1/agent-chat/conversations/{conversationId}/messages',
  '/v1/agent-chat/conversations/{conversationId}/approval',
  '/v1/agent-chat/conversations/{conversationId}/cancel',
  '/v1/agent-chat/conversations/{conversationId}/events',
] as const);

export const BOSS_AGENT_ID = 'boss-agent';
export const BOSS_AGENT_NAME = '老板 Agent';
export const BOSS_AGENT_REVISION_ID = 'boss-runtime-v1';
export const BOSS_AGENT_PROVIDER_ID = 'runtime';
export const BOSS_AGENT_MODEL_ID = '组织编排';

export interface AgentChatAgentView {
  readonly id: string;
  readonly name: string;
  readonly currentRevisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly isDefault: boolean;
  readonly archived: boolean;
}

export interface AgentChatConversationView {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly id: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configurationRevisionId: string;
  /**
   * The effort this conversation's next turn will run at, or `null` when its
   * model publishes no levels at all.
   */
  readonly reasoningEffort: AgentChatReasoningEffort | null;
  /**
   * The approval level actually in force for this conversation.
   *
   * Published rather than inferred: a client that sent `trusted` against a
   * `standard` Runtime must be able to show what it got, not what it asked for.
   */
  readonly permissionLevel: PermissionLevel;
  readonly messages: readonly AgentChatMessage[];
}

export interface AgentChatConversationSummary {
  readonly id: string;
  readonly agentId: string;
  readonly reasoningEffort: AgentChatReasoningEffort | null;
  readonly createdAt: string;
  readonly messageCount: number;
  readonly lastMessagePreview: string;
  /**
   * True when this conversation has a finished reply the user has not opened.
   * That is the one case a task list should surface above everything else; an
   * idle conversation with nothing new is deliberately not flagged.
   */
  readonly unread: boolean;
  readonly lastState: AgentChatMessageState | null;
}

export interface AgentChatConversationList {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversations: readonly AgentChatConversationSummary[];
  readonly defaultModelId: string | null;
}

/**
 * A task-driven approval has no model prose of its own. Explain, in the reader's
 * words, why the turn stopped — never an HTTP recipe, which belongs to the API.
 */
function withApprovalExplanation(message: AgentChatMessage): AgentChatMessage {
  if (message.state !== 'waiting_approval' || message.body.trim().length > 0) return message;
  return Object.freeze({
    ...message,
    body: approvalHintFor(message),
  });
}

/**
 * Says what the pending action actually is.
 *
 * The old text said "this will modify the workspace" for every approval,
 * including an outbound HTTP request and a git push. A reader deciding whether
 * to approve has to know which of those they are allowing, so the wording comes
 * from the tool named in the message and falls back to the neutral form.
 */
export function approvalHintFor(message: AgentChatMessage): string {
  /*
   * The tool name lives in different fields depending on the frame: the approval
   * entry carries it in `label` ("等待审批：http_fetch"), the tool entry in
   * `detail`. Reading only one of them is why the first version of this fell
   * through to the generic wording for every external tool.
   */
  const detail = message.activity
    .filter((entry) => entry.kind === 'approval' || entry.kind === 'tool')
    .map((entry) => `${entry.label} ${entry.detail ?? ''}`)
    .join(' ');
  if (/git_push/.test(detail)) {
    return '【需要你的批准】这一步会把本机提交推送到远程仓库，远程无法撤销。请确认分支与提交，然后选择批准或拒绝。';
  }
  if (/风险：external\b/.test(detail)) {
    return '【需要你的批准】这一步会访问外部地址或产生外部效果。请确认目标，然后选择批准或拒绝。';
  }
  if (/workspace_delete/.test(detail)) {
    return '【需要你的批准】这一步会删除工作区中的内容，且无法撤销。请确认目标路径，然后选择批准或拒绝。';
  }
  if (/workspace_move|workspace_copy/.test(detail)) {
    return '【需要你的批准】这一步会移动或复制工作区中的内容。请确认来源与目标，然后选择批准或拒绝。';
  }
  /*
   * At `strict` even reads need approval, so the fallback cannot assume a
   * write. Those are the only cases that reach here without a matched tool, and
   * telling the reader "this will modify the workspace" about a file read is
   * exactly the kind of misleading prompt this function exists to remove.
   */
  if (/workspace_read|workspace_list|text_search|git_status|git_diff|git_log/.test(detail)) {
    return '【需要你的批准】当前权限等级下，读取操作也需要确认。请查看目标，然后选择批准或拒绝。';
  }
  return '【需要你的批准】这一步会修改工作区。请查看上面的改动预览，然后选择批准或拒绝。';
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

export interface AgentChatCancelResult {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversationId: string;
  readonly assistantMessage: AgentChatMessage;
  /** True when a turn was actually stopped; false when nothing was running. */
  readonly cancelled: boolean;
}

export interface AgentChatStreamFrame {
  readonly version: typeof AGENT_CHAT_CONTRACT_VERSION;
  readonly conversationId: string;
  readonly kind: 'snapshot' | 'message' | 'health';
  /**
   * Additive AG-UI mapping. `kind` remains the Conchbase vocabulary;
   * this field lets an AG-UI client map the same frame without a
   * private adapter. `null` means the frame has no faithful AG-UI equivalent.
   */
  readonly agUiType: string | null;
  readonly eventId: string | null;
  readonly messageId: string | null;
  readonly message: AgentChatMessage | null;
  readonly conversation: AgentChatConversationView | null;
}

interface ConversationRecord
  extends Omit<AgentChatConversationRecord, 'idempotency' | 'reasoningEffort' | 'providerId' | 'modelId'> {
  readonly messages: AgentChatMessage[];
  readonly idempotency: Map<string, string>;
  /**
   * The model the next turn runs on.
   *
   * Writable because a reader may switch models mid-conversation; the identity
   * a conversation starts with is a default, not a lock. Each assistant message
   * records the model that actually produced it, so the transcript stays
   * truthful after a switch.
   */
  providerId: string;
  modelId: string;
  /**
   * The effort the next turn inherits.
   *
   * Writable because a reader may switch strength mid-conversation: the turn
   * they send it on uses the new value, and every later turn keeps it until
   * they switch again. Everything else on this record is fixed at creation.
   */
  reasoningEffort: string;
}

/**
 * A turn that has been accepted but whose task has not been created yet.
 *
 * Queued rather than started, because a task's prompt is built from the
 * transcript as it stands when the task is created. Two tasks created at once
 * each see a transcript without the other's reply, so "what did you mean by
 * that?" answered twice reads as one exchange in which neither reply knew of
 * the other. Waiting for the previous task to finish gives the later prompt the
 * earlier answer.
 *
 * The text is held here, not in the message body: the message a reader sees is
 * the same either way, and keeping the raw prompt out of the transcript means a
 * queued turn cannot reach a model before it starts.
 */
interface QueuedTurn {
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly text: string;
  readonly idempotencyKey: string;
  /**
   * The effort this turn asked for, resolved when it was queued.
   *
   * Captured here rather than read from the conversation when the turn starts:
   * the reader may change the effort for the *next* message while this one
   * waits, and a queued turn must run at the strength it was sent with.
   */
  readonly effort: string | undefined;
}

export class AgentChatServiceError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AgentChatServiceError';
    this.statusCode = statusCode;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(
  input: Omit<AgentChatMessage, 'phase' | 'progress' | 'updatedAt' | 'replyToId' | 'activity' | 'modelReference'>
    & Partial<Pick<AgentChatMessage, 'phase' | 'progress' | 'updatedAt' | 'replyToId' | 'activity' | 'modelReference'>>,
  now = () => new Date().toISOString(),
): AgentChatMessage {
  return Object.freeze({
    phase: phaseForState(input.state),
    progress: null,
    updatedAt: now(),
    replyToId: null,
    activity: Object.freeze([]),
    modelReference: null,
    ...input,
  });
}

const MAX_ACTIVITY = 8;

/**
 * The most recent turns the Runtime replays to a model.
 *
 * A fixed turn count, not a token budget: the transcript is flattened into one
 * prompt string, so the only place that can measure and trim it is the task's
 * agent loop — which does, per iteration, against the model's own window. This
 * constant bounds how much is *offered*; the budget decides what is *sent*.
 */
const CONVERSATION_WINDOW = 8;

/**
 * The messages that may be replayed to a model as its own conversation.
 *
 * A whitelist, not a filter of what to drop. Two things must never appear:
 *
 * - a Runtime notice (`author: 'runtime'`): it is the Runtime speaking, and
 *   presenting it as an assistant turn makes the model believe it said it;
 * - an in-flight assistant placeholder, whose empty body is not yet a turn (the
 *   Boss submission validator rejects empty bodies too).
 *
 * Written this way so a future author value is excluded by default instead of
 * leaking until someone remembers to add a case.
 *
 * The window is taken from the end, then trimmed forward to the first user
 * turn. A plain `slice(-8)` can start mid-exchange — one question still in
 * flight shifts the parity — and the model would open on an answer to a
 * question it cannot see. `Q a Q a Q a Q a` is a conversation; `a Q a Q a Q a`
 * is not, and a model reading it has to guess what the first answer replied to.
 *
 * The result is flattened to `User:`/`Assistant:` lines rather than passed as
 * structured turns, because a `Task` carries one `prompt: string`. That loses
 * nothing a model can exploit: user text is normalized by `boundedText`, which
 * replaces every control character — including newlines — with a space, so a
 * message cannot forge a line of its own. What it does lose is a user's
 * paragraph breaks, which arrive as one line. Carrying structured history is a
 * schema change; it is a formatting improvement, not a security one, and is not
 * made here.
 */
function conversationalHistory(messages: readonly AgentChatMessage[]): readonly AgentChatMessage[] {
  const turns = messages.filter((message) => message.author === 'user'
    || (message.author === 'assistant' && message.body.trim().length > 0));
  const window = turns.slice(-CONVERSATION_WINDOW);
  const firstUser = window.findIndex((message) => message.author === 'user');
  return firstUser > 0 ? window.slice(firstUser) : window;
}

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
  private static readonly MAX_CACHED_CONVERSATIONS = 64;
  private readonly store: AgentChatStore;

  /**
   * Turns accepted while an earlier task is still running, per conversation.
   *
   * Ordered by arrival. `settleRecord` starts the head once the conversation has
   * no live task, so a burst of messages becomes a sequence of turns rather than
   * a set of concurrent ones.
   */
  private readonly queuedTurns = new Map<string, QueuedTurn[]>();

  /**
   * Conversations with an in-flight promotion, so a settle cannot start two.
   *
   * The value is the promotion's own token, not just a flag. An evicted
   * conversation can be re-loaded and promoted again while the first launch is
   * still awaiting its task, and a bare `delete` in that first launch's
   * `finally` would clear the *second* promotion's mark — letting a third start
   * alongside it. Deleting only when the token still matches keeps the count at
   * one.
   */
  private readonly promoting = new Map<string, number>();
  private promotionToken = 0;

  /**
   * One task-change subscription per conversation that needs one.
   *
   * A conversation needs one for either of two reasons, and one listener serves
   * both:
   *
   * - it has a queue, which has to advance without a reader. Settling only on
   *   read would mean a conversation nobody is polling never runs its queued
   *   turn, making the Runtime depend on a client to drive its own state
   *   machine;
   * - a message it holds still presents a live task. A message *is* the
   *   presentation of its task, so the terminal transition — including a retry
   *   through `POST /v1/tasks/{id}/retry` — must reach the record without
   *   anyone opening the conversation. Otherwise the database says `succeeded`
   *   while the conversation, and any SSE client, still sees the old failure.
   *
   * It exists exactly while one of those holds, so an idle conversation holds
   * none and a discarded service leaves none behind. That property is asserted
   * by `agent-chat-concurrent.test.ts` and `agent-chat-stream.test.ts`.
   */
  private readonly queueWatchers = new Map<string, () => void>();

  constructor(
    readonly taskService: TaskService,
    private readonly bossMode?: BossModeService,
    private readonly now: () => string = () => new Date().toISOString(),
    store?: AgentChatStore,
    /**
     * Memory for direct conversations.
     *
     * Optional so existing callers keep working, but when absent a configured
     * Agent simply remembers nothing — which is the state this project was in
     * while memory appeared to exist for everyone.
     */
    private readonly memory?: AgentChatMemory,
    private readonly memoryProposer?: MemoryProposer,
  ) {
    this.store = store ?? taskService.store?.agentChat ?? new InMemoryAgentChatStore();
    this.store.initialize();
    // Write path: a task transition persists the projected message. Reads no
    // longer mutate state, so without this a finished task would only be
    // recorded when someone happened to query the conversation.
    // No subscription here on purpose. Settling is done lazily inside
    // `settleRecord`, which every read and every stream tick already calls.
    // Subscribing per service instance leaked a listener per construction and
    // made shutdown observable; the lazy path is both simpler and bounded.
  }

  private settleRecord(record: ConversationRecord, settledOnly = false): void {
    let changed = false;
    for (const message of [...record.messages]) {
      const task = message.taskId ? this.taskService.store.getTask(message.taskId) : null;
      const projected = projectMessage({
        message,
        task,
        activity: message.taskId ? this.taskActivity(message.taskId) : [],
        now: this.now(),
      });
      if (!projected) continue;
      /*
       * The task bus fires on every streamed delta, not only on a transition.
       * Persisting each projected body rewrote the whole conversation once per
       * token — quadratic work in the middle of a stream that starved the event
       * loop, measured as the process going unresponsive during one reply.
       *
       * A listener-driven settle therefore writes only when the *state* or the
       * error changes: a partial body needs no write, because the read path and
       * the SSE pump both project it from `task.partialOutput` on demand. State
       * still changes on retry (`failed → thinking → done`), which is exactly
       * the case a "task must be finished" gate missed.
       */
      if (settledOnly && projected.state === message.state && projected.error === message.error) continue;
      this.replaceMessage(record, message.id, projected);
      changed = true;
      /*
       * A reply that has just succeeded is the only moment worth mining.
       *
       * `done` is reached once per turn: re-projecting an already-settled
       * message returns early above, so this cannot propose twice. A failed or
       * cancelled turn is skipped — there is no exchange to remember, and
       * proposing from a partial answer is how a correction gets stored as a
       * fact.
       */
      if (projected.state === 'done' && message.state !== 'done' && message.state !== 'replied') {
        this.proposeMemory(record, projected);
      }
    }
    if (changed) this.persist(record);
    /*
     * Promote a queued turn while the caller is already here.
     *
     * The promotion is not awaited: a read must not wait for a model call, and
     * `promoting` makes a second read during the same window a no-op instead of
     * a second start.
     */
    this.startNextQueuedTurn(record);
    // Resync only outside a listener callback. Resyncing from inside one made
    // `watchQueue`/`unwatchQueue` alternate on every notification, which is why
    // the listener path could never settle: the subscription it needed was
    // being removed by the settle that used it. The subscription checks its own
    // reason to live at the end of a notification instead.
    if (!settledOnly) this.syncTaskWatch();
  }

  /**
   * Holds a conversation's subscription exactly while a task it presents can
   * still move.
   *
   * Three cases need it: a queued turn (which must advance without a reader), a
   * task still running behind a message, and a task that finished in a state
   * the user may retry. The third one is what makes a retry visible: releasing
   * on `failed` meant the retry's transitions reached nobody, so the
   * conversation kept showing the failure while the database held the answer.
   *
   * A task that ended `succeeded` or `cancelled` is retryable too, but nothing
   * currently retries it without the user asking, and keeping a subscription
   * alive for every completed turn would make an idle runtime hold one per
   * cached conversation. The read path still follows the task, so that case is
   * correct, just not push-driven.
   */
  private syncTaskWatch(): void {
    for (const record of [...this.conversations.values()]) {
      const queued = (this.queuedTurns.get(record.id)?.length ?? 0) > 0;
      if (queued || this.hasRetryableTask(record)) this.watchQueue(record);
      else this.unwatchQueue(record.id);
    }
  }

  /**
   * Asks for memory proposals after a successful turn, without blocking it.
   *
   * Deliberately fire-and-forget: the reply has already been written, and
   * making the reader wait for a second model call would double the latency of
   * every message. A proposal failure is silent because the conversation
   * succeeded — memory is an enhancement, not part of the answer.
   */
  private proposeMemory(record: ConversationRecord, assistantMessage: AgentChatMessage): void {
    const proposer = this.memoryProposer;
    if (!proposer || record.isBoss) return;
    const userMessage = record.messages.find((message) => message.id === assistantMessage.replyToId);
    if (!userMessage || userMessage.author !== 'user') return;
    if (assistantMessage.body.trim().length === 0) return;
    const agent = this.taskService.listAgents().find((entry) => entry.id === record.agentId);
    void proposer({
      agentId: record.agentId,
      agentName: agent?.current.name ?? record.agentId,
      userText: userMessage.body,
      assistantReply: assistantMessage.body,
      existingTitles: [],
    }).then((proposals) => {
      if (proposals.length === 0) return;
      return this.memory?.recordProposals(proposals, {
        agentId: record.agentId,
        userText: userMessage.body,
        assistantReply: assistantMessage.body,
        sourceIntentId: `chat:${record.id}:${assistantMessage.id}`,
      });
    }).catch(() => {
      // Never surfaced: the reply already landed.
    });
  }

  /**
   * Whether a task this conversation presents can still change on its own.
   *
   * Running counts, and so does a finished-but-retryable task: a retry of the
   * same id moves it back to `running` and then to `succeeded`, and only a
   * subscription at that moment makes the conversation follow. Measured: with
   * the subscription released on `failed`, the retried task succeeded in the
   * database while the message stayed "failed" forever for a reader who never
   * reopened it.
   */
  private hasRetryableTask(record: ConversationRecord): boolean {
    return record.messages.some((message) => {
      if (message.author !== 'assistant' || message.taskId === null) return false;
      if (!terminalMessageState(message.state)) return true;
      const task = this.taskService.store.getTask(message.taskId);
      return task !== null && (task.state === 'failed' || task.state === 'interrupted');
    });
  }

  /**
   * Starts the next queued turn once nothing in the conversation is running.
   *
   * Called from `settleRecord`, which every read and stream tick already runs,
   * so a finished task promotes its successor without a subscription per
   * conversation. Starting more than one would reintroduce the concurrency this
   * queue exists to remove, so the head is only taken when the conversation is
   * idle.
   */
  private startNextQueuedTurn(record: ConversationRecord): void {
    if (this.promoting.has(record.id)) return;
    let userMessage: AgentChatMessage | undefined;
    let assistantMessage: AgentChatMessage | undefined;
    let next: QueuedTurn | undefined;
    for (;;) {
      const queue = this.queuedTurns.get(record.id);
      if (!queue || queue.length === 0) {
        // An empty queue is one reason for a subscription to exist, not the
        // only one. Releasing here unconditionally is what dropped the watch on
        // a task that had just failed — the very task a user retries.
        if (!this.hasRetryableTask(record)) this.unwatchQueue(record.id);
        return;
      }
      // The queued turn itself is not live yet, so only its predecessor can be.
      if (this.runningTurnIn(record)) return;

      next = queue.shift();
      if (!next) return;
      if (queue.length === 0) {
        this.queuedTurns.delete(record.id);
      }

      userMessage = record.messages.find((message) => message.id === next!.userMessageId);
      assistantMessage = record.messages.find((message) => message.id === next!.assistantMessageId);
      /*
       * Messages are never removed from a record, so this cannot happen today.
       *
       * If it ever does, this turn is dropped and the loop takes the next one.
       * Throwing would be worse: this runs from `settleRecord`, which `view()`
       * calls — a broken queue entry would turn every read of the conversation
       * into a 500 — and from the task-change listener, where an exception
       * would reach `notifyChange` and stop the remaining listeners from
       * hearing about the transition. A corrupt entry must not take either
       * down, and it must not stall the turns queued behind it.
       */
      if (userMessage && assistantMessage) break;
    }

    /*
     * The prompt is the transcript up to and including this turn.
     *
     * Not the whole record: a later question may already be queued behind this
     * one, and it must not appear — the reply being written cannot answer a
     * question the reader has not had answered yet, and a model that sees it
     * will answer both. Not re-appended either: this question is already a turn
     * in the transcript, so adding the text again would repeat it.
     */
    const upToThisTurn = record.messages.filter((message) => message.sequence <= assistantMessage.sequence);
    const prompt = conversationalHistory(upToThisTurn).map((message) =>
      `${message.author === 'user' ? 'User' : 'Assistant'}: ${message.body}`).join('\n');

    const token = (this.promotionToken += 1);
    this.promoting.set(record.id, token);
    void this.launchQueuedTurn(record, next, userMessage, assistantMessage, prompt)
      .finally(() => { this.releasePromotion(record.id, token); });
  }

  /**
   * Clears a promotion mark, but only if it is still the one that set it.
   *
   * An evicted conversation can be re-loaded and promoted while an earlier
   * launch is still awaiting its task. The earlier launch's release then runs
   * against a conversation that already carries a newer mark. Clearing by id
   * alone would remove the newer mark and let a third turn start beside it.
   */
  releasePromotion(conversationId: string, token: number): void {
    if (this.promoting.get(conversationId) === token) this.promoting.delete(conversationId);
  }

  /**
   * Subscribes this conversation's queue to task transitions.
   *
   * Called when a turn is queued and released when the queue empties, so the
   * listener's lifetime is the queue's. Subscribing in the constructor would be
   * simpler but leaves one listener per service instance forever, which a test
   * already guards against.
   *
   * This listener releases itself: the queue drains inside the callback. That is
   * safe with the `Set` `notifyChange` iterates — removing the entry the
   * iterator is currently on does not skip the next one. Removing a *different*
   * entry would, so a future change that clears every watcher from here must
   * not run inside the callback.
   */
  private watchQueue(record: ConversationRecord): void {
    if (this.queueWatchers.has(record.id)) return;
    const unsubscribe = this.taskService.onChange((taskId) => {
      /*
       * Only react to a task this conversation owns. A transition elsewhere is
       * not a reason to touch this record, and reacting to it would start a turn
       * while its own predecessor is still running.
       */
      const owned = record.messages.some((message) => message.taskId === taskId);
      if (!owned) return;
      /*
       * Settle first: the task carries its output the moment it finishes, but
       * this conversation's assistant message only learns the body when it is
       * projected. Promoting before that would build the next prompt from a
       * transcript whose previous reply is still empty.
       */
      this.settleRecord(record, true);
      /*
       * Leave when nothing is left to follow.
       *
       * The check lives here rather than calling `syncTaskWatch`, because that
       * wider sync also re-adds the subscription and the pair oscillated on
       * every notification. Releasing from inside this callback is safe:
       * `TaskService.notifyChange` iterates a `Set`, so deleting the entry it is
       * currently on does not skip the next one.
       */
      const queuedLeft = (this.queuedTurns.get(record.id)?.length ?? 0) > 0;
      /*
       * One definition of "may still move", shared with `syncTaskWatch`.
       *
       * An earlier version tested the message's terminal flag here and
       * released on `failed` — which is exactly the state a user retries from,
       * so the retry's transitions reached nobody. `hasRetryableTask` also asks
       * whether the task behind the message is retryable, and it is the rule
       * that matters.
       */
      if (!queuedLeft && !this.hasRetryableTask(record)) this.unwatchQueue(record.id);
    });
    this.queueWatchers.set(record.id, unsubscribe);
  }

  private unwatchQueue(conversationId: string): void {
    const unsubscribe = this.queueWatchers.get(conversationId);
    if (!unsubscribe) return;
    unsubscribe();
    this.queueWatchers.delete(conversationId);
  }

  private async launchQueuedTurn(
    record: ConversationRecord,
    turn: QueuedTurn,
    userMessage: AgentChatMessage,
    assistantMessage: AgentChatMessage,
    prompt: string,
  ): Promise<void> {
    try {
      const task = await this.taskService.createAgentTaskWithEffort({
        prompt,
        agentId: record.agentId,
        expectedAgentRevisionId: record.agentRevisionId,
        modelOverride: { providerId: record.providerId, modelId: record.modelId },
      }, turn.effort);
      // Sending a message while the conversation is busy queues a turn; that
      // turn still runs under the level the conversation was created with.
      if (record.permissionLevel !== null) {
        this.taskService.setTaskPermissionLevel(task.id, record.permissionLevel);
      }
      this.replaceMessage(record, assistantMessage.id, {
        ...assistantMessage,
        state: 'thinking',
        taskId: task.id,
        /* Same rule as the direct path: the task's model, recorded when the turn
           starts, so a later switch cannot rewrite this reply's provenance. */
        modelReference: task.providerId && task.modelId
          ? `${task.providerId}:${task.modelId}`
          : null,
        updatedAt: this.now(),
      });
      this.persist(record);
      try {
        this.taskService.startTask(task.id);
      } catch (cause) {
        this.replaceMessage(record, assistantMessage.id, {
          ...assistantMessage,
          body: 'Runtime 无法启动 Agent 任务。',
          state: 'failed',
          error: cause instanceof Error ? safeTaskError(cause, 240) : 'Task start failed.',
          updatedAt: this.now(),
        });
        this.persist(record);
      }
    } catch (cause) {
      const errorText = cause instanceof Error ? safeTaskError(cause, 240) : 'Agent task creation failed.';
      this.replaceMessage(record, assistantMessage.id, {
        ...assistantMessage,
        body: unavailableError(errorText)
          ? '模型目录暂不可用，请检查 Magpie 配置。'
          : 'Agent 任务创建失败。',
        state: unavailableError(errorText) ? 'unavailable' : 'failed',
        error: errorText,
        updatedAt: this.now(),
      });
      this.persist(record);
    }
    this.projectForRead(record);
  }

  /**
   * Whether a turn is already running in this conversation.
   *
   * A queued turn is not live: it has no task yet, and the whole point of the
   * queue is that the next head starts once this becomes false.
   */
  private hasLiveTurn(record: ConversationRecord): boolean {
    if ((this.queuedTurns.get(record.id)?.length ?? 0) > 0) return true;
    return this.runningTurnIn(record);
  }

  /**
   * Whether any turn in this conversation still has a task running.
   *
   * One definition for both callers: the queue asks "may I start the next turn",
   * and a new message asks "should I queue at all". Two copies would drift, and
   * drifting here means either two tasks at once or a queue that never advances.
   */
  private runningTurnIn(record: ConversationRecord): boolean {
    return record.messages.some((message) => {
      if (message.author !== 'assistant' || message.taskId === null) return false;
      const task = this.taskService.store.getTask(message.taskId);
      return task !== null && !isTerminalTaskState(task.state);
    });
  }

  /**
   * Records a turn without starting it.
   *
   * The message pair exists immediately so the reader sees their own question
   * and a "queued" reply; the task is created when the preceding one finishes.
   * `taskId` stays null, which is also what `projectMessage` uses to leave a
   * message alone until it has real task state behind it.
   */
  private enqueueTurn(
    record: ConversationRecord,
    text: string,
    idempotencyKey: string,
    effort: string | undefined,
  ): AgentChatMessageResult {
    const userMessage = message({
      id: referenceDigest('amsg', `${record.id}:${idempotencyKey}:user`),
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
      id: referenceDigest('amsg', `${record.id}:${idempotencyKey}:assistant`),
      sequence: record.messages.length + 2,
      author: 'assistant',
      body: '',
      state: 'pending',
      taskId: null,
      error: null,
      phase: 'preparing',
      replyToId: userMessage.id,
      updatedAt: this.now(),
    }, this.now);
    record.messages.push(userMessage, assistantMessage);
    record.idempotency.set(idempotencyKey, userMessage.id);
    this.persist(record);

    const queue = this.queuedTurns.get(record.id) ?? [];
    queue.push({
      conversationId: record.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      text,
      idempotencyKey,
      effort,
    });
    this.queuedTurns.set(record.id, queue);
    this.watchQueue(record);
    this.syncTaskWatch();

    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId: record.id,
      userMessage,
      assistantMessage,
    });
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
    const allowed = new Set(['agentId', 'modelOverride', 'reasoningEffort', 'permissionLevel']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new AgentChatServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
    const agentId = input.agentId === undefined
      ? this.defaultAgentId()
      : boundedText(input.agentId, 'agentId');
    const modelOverride = this.parseModelOverride(input.modelOverride);
    const requestedEffort = this.readEffort(input.reasoningEffort);
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
    /*
     * The Boss is pinned to the model it actually calls, not to its display
     * identity.
     *
     * `bossAgentView()` answers "runtime / 组织编排", which is what the header
     * should read — the Boss is the Runtime's own planner, not a configurable
     * provider route. But no gateway has heard of that pair, so storing it here
     * made every downstream question about the Boss's model answer "unknown":
     * the catalogue lookup returned nothing, the effort picker found no levels,
     * and a per-turn override was refused as unsupported. The conversation now
     * records the real provider/model; the virtual identity stays where it
     * belongs, in the Agent list and the header.
     */
    const bossModel = isBoss ? this.bossMode?.modelReference : undefined;
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
    /*
     * The chosen effort has to be one this model actually publishes.
     *
     * Checked at creation, not only at send time: a conversation that stores a
     * value its model cannot accept is exactly what made "思考强度" look like a
     * setting that changed nothing. Refusing up front leaves the choice where
     * the reader can see it.
     */
    const reasoningEffort = await this.resolveEffort({
      providerId: modelOverride?.providerId ?? bossModel?.providerId ?? agent.providerId,
      modelId: modelOverride?.modelId ?? bossModel?.modelId ?? agent.modelId,
    }, requestedEffort, true);
    /*
     * A conversation may ask to be more cautious than the Runtime, never less.
     *
     * The narrowing happens once, here, and the result is pinned on the
     * conversation. Re-reading it per message would let a conversation loosen
     * while an approval was pending — which is the one moment the choice
     * matters.
     */
    const requestedLevel = input.permissionLevel;
    if (requestedLevel !== undefined && !isPermissionLevel(requestedLevel)) {
      throw new AgentChatServiceError('permissionLevel must be strict, standard, or trusted.', 400);
    }
    const operatorLevel = this.taskService.effectivePermissionLevel;
    const permissionLevel = requestedLevel === undefined
      ? null
      : narrowPermissionLevel(operatorLevel, requestedLevel);
    const id = referenceDigest('chat', `${agent.id}:${agent.currentRevisionId}:${randomUUID()}`);
    const record: ConversationRecord = {
      id,
      agentId: isBoss ? BOSS_AGENT_ID : agent.id,
      agentRevisionId: agent.currentRevisionId,
      providerId: modelOverride?.providerId ?? bossModel?.providerId ?? agent.providerId,
      modelId: modelOverride?.modelId ?? bossModel?.modelId ?? agent.modelId,
      configurationRevisionId: this.taskService.activeConfigurationRevisionId,
      isBoss,
      /*
       * Stored as `''` when the model publishes no levels, never as a default.
       * The column is NOT NULL (SQLite cannot relax that in place), so an empty
       * token is the one value that records "no effort control" without
       * inventing a level the model would ignore.
       */
      reasoningEffort: reasoningEffort ?? '',
      permissionLevel,
      createdAt: this.now(),
      lastReadAt: null,
      messages: [],
      idempotency: new Map(),
    };
    this.conversations.set(id, record);
    this.evictIfOverCapacity(id);
    this.persist(record);
    return this.view(id);
  }

  /**
   * Read the effort a request asked for, bounded but not yet validated.
   *
   * Shape only. Whether the model admits it is `resolveEffort`'s job, which
   * needs the catalogue; keeping the two apart means a malformed token fails
   * before any network call.
   */
  private readEffort(value: unknown): string | undefined {
    try {
      return parseEffortToken(value);
    } catch {
      // The service owns its error type; the shared parser stays transport-free.
      throw new AgentChatServiceError(
        'reasoningEffort must be a short lowercase token such as low, medium, or high.',
      );
    }
  }

  /**
   * Resolve the effort to pin, against what the model actually publishes.
   *
   * Three outcomes, and all three are different facts:
   *   - the model publishes levels and the request named one of them → that one
   *   - the model publishes levels and the request was silent → the middle step
   *   - the model publishes none → `undefined`, and nothing is sent
   *
   * The middle step is chosen from the published list rather than assumed to be
   * `medium`: a model offering only `none/low/high/max` has no `medium` at all.
   *
   * `strict` is true only when a person explicitly asked for a level. An
   * inherited value that the gateway has since withdrawn must not block a
   * turn, but a person typing "use xhigh" against a model that has no levels
   * deserves to be told, not quietly overridden.
   */
  private async resolveEffort(
    reference: { readonly providerId: string; readonly modelId: string },
    requested: string | undefined,
    strict = false,
  ): Promise<string | undefined> {
    let levels: readonly string[] | undefined;
    try {
      levels = await this.taskService.reasoningLevelsFor(reference);
    } catch {
      /*
       * A catalogue outage must not block a conversation that was going to work
       * anyway. Falling back to the requested value defers the decision to the
       * gateway, which is the same authority — it will ignore what it cannot
       * honour, and the next read will report the catalogue again.
       */
      return requested;
    }
    if (levels === undefined || levels.length === 0) {
      if (strict && requested !== undefined) {
        throw new AgentChatServiceError(
          `这个模型（${reference.modelId}）没有公布思考强度档位，不能指定「${requested}」。`,
          400,
        );
      }
      return undefined;
    }
    const ordered = sortEfforts(levels);
    if (requested !== undefined) {
      if (ordered.includes(requested)) return requested;
      if (strict) {
        throw new AgentChatServiceError(
          `这个模型不支持「${requested}」这一档思考强度；可选：${ordered.join('、')}。`,
          400,
        );
      }
      // Withdrawn since it was stored. Fall through to the published middle.
    }
    return defaultEffort(ordered);
  }

  /**
   * The effort a single turn should run at.
   *
   * One turn may override what the conversation is pinned to, and an override
   * is checked against the live catalogue like any other choice. A turn that
   * says nothing inherits the conversation's stored effort — but only after
   * confirming the model still accepts it, because the gateway can revoke a
   * level between turns and a stored value is a memory, not an authority.
   */
  private async effortForTurn(
    record: ConversationRecord,
    requested: string | undefined,
  ): Promise<string | undefined> {
    const stored = record.reasoningEffort.length > 0 ? record.reasoningEffort : undefined;
    /*
     * Nothing to ask when nothing was chosen.
     *
     * An empty stored effort means this conversation's model published no
     * levels when it was created, and the caller named none now — so there is
     * no question to put to the catalogue. Skipping the read keeps the common
     * turn free of a network round trip, and avoids holding a fast turn open
     * behind a model list it will not use.
     */
    if (requested === undefined && stored === undefined) return undefined;
    const reference = { providerId: record.providerId, modelId: record.modelId };
    if (requested !== undefined) return this.resolveEffort(reference, requested, true);
    if (stored === undefined) return this.resolveEffort(reference, undefined);
    /*
     * Not strict: a level the gateway has since withdrawn must not strand the
     * conversation on a setting the reader cannot fix without starting over.
     * `resolveEffort` falls back to the published middle, and the next read
     * reports the new list.
     */
    return this.resolveEffort(reference, stored);
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
    const allowed = new Set<string>(AGENT_CHAT_MESSAGE_REQUEST_FIELDS);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new AgentChatServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
    const text = boundedText(input.text, 'text').slice(0, 6000);
    const idempotencyKey = boundedText(input.idempotencyKey, 'idempotencyKey').slice(0, 200);
    /*
     * A conversation may change model between turns.
     *
     * The identity a conversation is *created* with is a starting point, not a
     * lock: a reader who finds a model too slow, or one whose quota ran out,
     * should switch it and keep the thread — the transcript is the asset, and
     * forcing a new conversation to change models throws it away.
     *
     * Applied before anything is written, for the same reason the effort is:
     * an unavailable model must be refused while the transcript is still
     * untouched, not after a user message and a placeholder have been appended.
     */
    const requestedModel = this.parseModelOverride(input.modelOverride);
    if (requestedModel) {
      try {
        await this.taskService.validateModelReference(requestedModel);
      } catch (cause) {
        throw new AgentChatServiceError(
          cause instanceof Error ? cause.message.slice(0, 240) : 'Model override is not available.',
          400,
        );
      }
      record.providerId = requestedModel.providerId;
      record.modelId = requestedModel.modelId;
      /*
       * The level belonged to the old model. Carrying it across is how a
       * conversation ends up sending `medium` to a model that publishes
       * `none/low/high/max`; re-resolving here picks the new model's middle
       * step, and a level the caller sent explicitly is still checked below.
       */
      const carried = record.reasoningEffort.length > 0 ? record.reasoningEffort : undefined;
      record.reasoningEffort = (await this.resolveEffort(requestedModel, carried)) ?? '';
      this.persist(record);
    }
    /*
     * Per-message effort, resolved before anything is written.
     *
     * A turn is the unit the reader actually chooses for: "this question is
     * worth thinking about" is a property of the question, not of the
     * conversation. Omitting the field keeps the conversation's stored choice,
     * so a client that only knows about conversations still behaves as before.
     *
     * Resolved here rather than at task creation so an unsupported value is
     * refused before a user message and a placeholder reply are appended —
     * otherwise the transcript would show a message that was never sendable.
     */
    const requestedEffort = input.reasoningEffort === undefined
      ? undefined
      : this.readEffort(input.reasoningEffort);
    const turnEffort = await this.effortForTurn(record, requestedEffort);
    if (requestedEffort !== undefined) {
      /*
       * The chosen strength becomes the conversation's new default: the next
       * turn inherits it, so a reader who switches to "深入" once does not have
       * to switch again on every message.
       */
      record.reasoningEffort = turnEffort ?? '';
      this.persist(record);
    } else if (turnEffort !== (record.reasoningEffort.length > 0 ? record.reasoningEffort : undefined)) {
      /*
       * An inherited level was no longer accepted. Record the one that was
       * used, so the chip the reader sees matches what actually ran instead of
       * continuing to advertise a level the gateway has dropped.
       */
      record.reasoningEffort = turnEffort ?? '';
      this.persist(record);
    }
    let attachments: readonly Attachment[];
    try {
      attachments = parseAttachments(input.attachments);
    } catch (cause) {
      throw new AgentChatServiceError(
        cause instanceof AttachmentError ? cause.message : 'Attachments are invalid.',
        400,
      );
    }
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

    /*
     * The Boss path resolves its own task, so it cannot attach bytes.
     *
     * It never could: `postBossMessage` hands text to `BossModeService`, which
     * starts worker tasks of its own. Accepting `attachments` here would parse
     * and validate them, then drop them — the reader would see the file
     * uploaded while the model answered about nothing. The queue has the same
     * limitation and refuses for the same reason.
     */
    if (record.isBoss) {
      if (attachments.length > 0) {
        throw new AgentChatServiceError(
          '老板对话暂时不能附带文件；请切换到普通 Agent 对话再发送。',
          409,
        );
      }
      return this.postBossMessage(record, text, idempotencyKey);
    }

    /*
     * A turn waits for the one before it.
     *
     * The prompt is built from the transcript at the moment the task starts, so
     * two tasks started together each miss the other's reply. The composer
     * promises a reader can keep writing while a reply is generating; queueing
     * keeps that promise and gives the later prompt the earlier answer, instead
     * of flattening two questions into one user turn.
     */
    if (this.hasLiveTurn(record)) {
      /*
       * A queued turn cannot carry images yet.
       *
       * The queue stores text only, and accepting the attachment here would drop
       * it silently — the user would see their screenshot uploaded and the model
       * would answer about nothing. Refusing is the honest behaviour until the
       * queue carries bytes too.
       */
      if (attachments.length > 0) {
        throw new AgentChatServiceError(
          '这段对话还在回复中，暂时不能附带图片；请等上一条回复结束后再发送。',
          409,
        );
      }
      return this.enqueueTurn(record, text, idempotencyKey, turnEffort);
    }

    const context = conversationalHistory(record.messages).map((message) =>
      `${message.author === 'user' ? 'User' : 'Assistant'}: ${message.body}`).join('\n');
    /*
     * Memory is prepended, never appended.
     *
     * It is recollection, not a turn: putting it after the transcript would read
     * as something the assistant just said, and the model would answer it. The
     * block is bounded by `renderMemoryIndex`, and it states its own limits so a
     * model does not treat a one-line index as full knowledge.
     */
    const memory = this.memory?.index(record.agentId) ?? '';
    const withMemory = memory.length > 0
      ? `以下是关于这位用户的已知信息（仅作参考，如与本轮要求冲突以本轮为准）：\n${memory}\n\n`
      : '';
    const prompt = `${withMemory}${context.length > 0 ? `${context}\n\nUser: ${text}` : text}`;
    let task: TaskSnapshot;
    try {
      task = await this.taskService.createAgentTaskWithEffort({
        prompt,
        agentId: record.agentId,
        expectedAgentRevisionId: record.agentRevisionId,
        modelOverride: { providerId: record.providerId, modelId: record.modelId },
      }, turnEffort);
      if (attachments.length > 0) {
        /*
         * Split by kind at the boundary, so the task store holds two narrow
         * lists rather than a union each consumer has to re-discriminate.
         */
        const images = attachments.filter((entry): entry is ImageAttachment => entry.kind === 'image');
        const documents = attachments.filter((entry): entry is TextAttachment => entry.kind === 'text');
        if (images.length > 0) {
          this.taskService.attachImages(task.id, images.map((image) => ({
            mediaType: image.mediaType,
            dataUrl: image.dataUrl,
          })));
        }
        if (documents.length > 0) {
          this.taskService.attachDocuments(task.id, documents.map((document) => ({
            name: document.name,
            mediaType: document.mediaType,
            text: document.text,
          })));
        }
      }
      /*
       * Carry the conversation's pinned level onto the task.
       *
       * The task is what the loop consults when it decides whether a tool needs
       * approval, so the choice has to travel with it — including for a queued
       * turn that starts minutes later.
       */
      if (record.permissionLevel !== null) {
        this.taskService.setTaskPermissionLevel(task.id, record.permissionLevel);
      }
    } catch (cause) {
      const errorText = cause instanceof Error ? cause.message.slice(0, 240) : 'Agent task creation failed.';
      if (cause instanceof Error && cause.name.includes('NotFound')) {
        throw new AgentChatServiceError(errorText, 404);
      }
      const userMessage = message({
        id: referenceDigest('amsg', `${record.id}:${idempotencyKey}:failed-user`),
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
        id: referenceDigest('amsg', `${record.id}:${idempotencyKey}:failed-assistant`),
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
      id: referenceDigest('amsg', `${conversationId}:${task.id}:user`),
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
      id: referenceDigest('amsg', `${conversationId}:${task.id}:assistant`),
      sequence: record.messages.length + 2,
      author: 'assistant',
      body: '',
      state: 'thinking',
      taskId: task.id,
      error: null,
      phase: 'preparing',
      replyToId: userMessage.id,
      /*
       * Captured from the task, not from the record: the reader may switch
       * model again while this reply is still generating, and this answer must
       * keep saying which model wrote it.
       */
      modelReference: task.providerId && task.modelId
        ? `${task.providerId}:${task.modelId}`
        : null,
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
    this.projectForRead(record);
    // `projectForRead` settles but does not necessarily create the
    // subscription this turn needs; without this a single-turn conversation
    // would never hear that its task finished.
    this.syncTaskWatch();
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
    this.projectForRead(record);
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      assistantMessage: this.getMessage(record, assistant.id)!,
    });
  }

  /**
   * Stops the turn a conversation is currently waiting on.
   *
   * Two different things count as "running" from a reader's point of view: a
   * task the model is working through, and a turn still queued behind an earlier
   * one. A queued turn has no task to abort, so it is dropped from the queue and
   * settled directly — otherwise cancelling the newest message would do nothing
   * and the reply would arrive anyway.
   */
  cancelTurn(conversationId: string): AgentChatCancelResult {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);

    const queued = this.queuedTurns.get(conversationId) ?? [];
    const queuedAssistantId = queued.at(-1)?.assistantMessageId ?? null;
    const live = [...record.messages].reverse().find((message) => message.author === 'assistant'
      && message.taskId !== null && !terminalMessageState(message.state));
    const targetId = queuedAssistantId ?? live?.id ?? null;
    if (targetId === null) {
      throw new AgentChatServiceError('This conversation has no running reply to cancel.', 409);
    }

    if (queuedAssistantId !== null) {
      const remaining = queued.filter((turn) => turn.assistantMessageId !== queuedAssistantId);
      if (remaining.length === 0) {
        this.queuedTurns.delete(conversationId);
        this.unwatchQueue(conversationId);
      } else {
        this.queuedTurns.set(conversationId, remaining);
      }
      const message = this.getMessage(record, queuedAssistantId);
      if (message) {
        this.replaceMessage(record, queuedAssistantId, Object.freeze({
          ...message,
          state: 'cancelled',
          phase: 'terminal',
          progress: null,
          error: null,
          body: '这条回复在开始前已被取消。',
          updatedAt: this.now(),
        }));
        this.persist(record);
      }
      return Object.freeze({
        version: AGENT_CHAT_CONTRACT_VERSION,
        conversationId,
        assistantMessage: this.getMessage(record, queuedAssistantId)!,
        cancelled: true,
      });
    }

    const taskId = live!.taskId!;
    try {
      this.taskService.cancelTask(taskId);
    } catch (cause) {
      if (cause instanceof TaskNotFoundError) {
        throw new AgentChatServiceError('Agent task not found.', 404);
      }
      if (cause instanceof TaskConflictError) {
        throw new AgentChatServiceError(cause.message, 409);
      }
      throw cause instanceof Error
        ? new AgentChatServiceError(cause.message.slice(0, 240), 400)
        : new AgentChatServiceError('Cancel failed.');
    }
    /*
     * Settle the message here rather than waiting for the projection.
     *
     * `cancelTask` moves the task to `cancelling`, which is not terminal, so a
     * projection still reports "thinking". The user pressed stop: the reply has
     * to look stopped immediately, and the later task notification will confirm
     * it when the abort lands.
     */
    const current = this.getMessage(record, live!.id);
    if (current) {
      this.replaceMessage(record, live!.id, Object.freeze({
        ...current,
        state: 'cancelled',
        phase: 'terminal',
        progress: null,
        error: null,
        body: current.body.trim().length > 0 ? current.body : '这条回复已取消。',
        updatedAt: this.now(),
      }));
      this.persist(record);
    }
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      assistantMessage: this.getMessage(record, live!.id)!,
      cancelled: true,
    });
  }

  view(conversationId: string): AgentChatConversationView {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    // Project first: a task that has just finished only becomes `done` during
    // projection, so "mark read" has to run against the projected message, not
    // the stale stored one.
    const projected = this.projectForRead(record);
    // Reading the conversation is the signal that a finished reply has been
    // seen. Promote `done` to `replied` in the record and in what we return.
    const seen = projected.map((message) => (message.state === 'done'
      ? Object.freeze({ ...message, state: 'replied' as const })
      : message));
    this.markRead(record);
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      id: record.id,
      agentId: record.agentId,
      agentRevisionId: record.agentRevisionId,
      providerId: record.providerId,
      modelId: record.modelId,
      configurationRevisionId: record.configurationRevisionId,
      reasoningEffort: this.publishedEffort(record),
      permissionLevel: record.permissionLevel ?? this.taskService.effectivePermissionLevel,
      messages: Object.freeze(seen.map((message) => Object.freeze({ ...message }))),
    });
  }

  /**
   * The effort to publish for a conversation.
   *
   * Stored as `''` when the model has no levels; published as `null` so a
   * client can tell "no effort control" apart from "the level happens to be
   * called something odd". An empty string on the wire would read as a value
   * and the composer would try to render it.
   */
  private publishedEffort(
    record: Pick<AgentChatConversationRecord, 'reasoningEffort'>,
  ): string | null {
    return record.reasoningEffort.length > 0 ? record.reasoningEffort : null;
  }

  conversationTaskIds(conversationId: string): readonly string[] {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    return Object.freeze([...new Set(record.messages.flatMap((message) =>
      message.taskId === null ? [] : [message.taskId]))]);
  }

  conversationRevision(conversationId: string): string {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    if (record.messages.length === 0) return 'rev_0_0';
    const digest = createHash('sha256');
    for (const message of record.messages) {
      digest.update(`${message.id}:${message.updatedAt}:${message.sequence}:${message.state};`);
    }
    return `rev_${record.messages.length}_${digest.digest('hex').slice(0, 16)}`;
  }

  snapshotFrame(conversationId: string, cursor: string | null): AgentChatStreamFrame {
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      kind: 'snapshot',
      agUiType: agUiEventType({ kind: 'snapshot' }),
      eventId: cursor,
      messageId: null,
      message: null,
      conversation: this.view(conversationId),
    });
  }

  /**
   * Appends a Runtime-authored notice to the Boss conversation.
   *
   * This is the only way the Runtime speaks on its own. It is deliberately
   * narrow: only a Boss conversation accepts it, the body is bounded and
   * screened, and an existing message with the same id is never duplicated so a
   * periodic sweep cannot spam the user.
   */
  announceBossNotice(input: {
    readonly conversationId: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }): AgentChatMessage {
    const record = this.load(input.conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    if (!record.isBoss) throw new AgentChatServiceError('Only the Boss conversation accepts Runtime notices.', 409);
    const key = `runtime-notice:${input.idempotencyKey}`;
    const existing = record.messages.find((message) => message.id === referenceDigest('amsg', `${record.id}:${key}`));
    if (existing) return existing;
    const text = input.body.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 4_000);
    if (text.length === 0) throw new AgentChatServiceError('Runtime notice must not be empty.');
    if (containsSecretLike(text)) throw new AgentChatServiceError('Runtime notice contains secret-like content.');
    // A notice is the Runtime speaking, not the Agent. Labelling it
    // `assistant` made the transcript claim the model had said something it
    // never said, and — because the context builders keep any non-empty body —
    // replayed the notice back to the model as one of its own turns.
    const notice = message({
      id: referenceDigest('amsg', `${record.id}:${key}`),
      sequence: record.messages.length + 1,
      author: 'runtime',
      body: text,
      state: 'done',
      taskId: null,
      error: null,
      phase: 'terminal',
      updatedAt: this.now(),
    }, this.now);
    record.messages.push(notice);
    record.idempotency.set(key, notice.id);
    this.persist(record);
    return notice;
  }

  eventFrame(
    conversationId: string,
    eventId: string,
    taskId: string,
  ): AgentChatStreamFrame | null {
    const record = this.load(conversationId);
    if (!record) throw new AgentChatServiceError('Agent Chat conversation not found.', 404);
    this.projectForRead(record);
    const message = record.messages.find((entry) => entry.taskId === taskId);
    if (!message) return null;
    return Object.freeze({
      version: AGENT_CHAT_CONTRACT_VERSION,
      conversationId,
      kind: 'message',
      agUiType: agUiEventType({
        kind: 'message',
        messageState: message.state,
        author: message.author,
      }),
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
        const unread = record.messages.some((entry) => entry.author === 'assistant' && entry.state === 'done');
        return Object.freeze({
          id: record.id,
          agentId: record.agentId,
          reasoningEffort: this.publishedEffort(record),
          createdAt: record.createdAt,
          messageCount: record.messages.length,
          unread,
          lastState: last?.state ?? null,
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
    /*
     * The Boss is listed under the identity a reader recognises — the Runtime's
     * own planner — and under the model it actually calls.
     *
     * Those were the same field before, which meant a client asking "what does
     * this Agent run on" got `runtime:组织编排`: a name no gateway knows. Since
     * a client needs that answer to find the model's effort levels, the real
     * reference is published here whenever one is configured, and the virtual
     * pair remains only as the fallback for a Boss with no fixed model.
     */
    const model = this.bossMode?.modelReference;
    return Object.freeze({
      id: BOSS_AGENT_ID,
      name: BOSS_AGENT_NAME,
      currentRevisionId: BOSS_AGENT_REVISION_ID,
      providerId: model?.providerId ?? BOSS_AGENT_PROVIDER_ID,
      modelId: model?.modelId ?? BOSS_AGENT_MODEL_ID,
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
    const conversation = conversationalHistory(record.messages).map((message) => ({
      author: message.author === 'user' ? 'user' as const : 'assistant' as const,
      body: message.body,
    }));
    const userMessage = message({
      id: referenceDigest('amsg', `${record.id}:${idempotencyKey}:user`),
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
      id: referenceDigest('amsg', `${record.id}:${idempotencyKey}:assistant`),
      sequence: record.messages.length + 2,
      author: 'assistant',
      body: '',
      state: 'thinking',
      taskId: null,
      error: null,
      phase: 'preparing',
      replyToId: userMessage.id,
      /*
       * The Boss answers through one model per turn, chosen at submit time.
       * Recording it here means a later switch does not rewrite which model
       * wrote this answer.
       */
      modelReference: `${record.providerId}:${record.modelId}`,
      updatedAt: this.now(),
    }, this.now);
    record.messages.push(userMessage, assistantMessage);
    record.idempotency.set(idempotencyKey, userMessage.id);
    this.persist(record);
    // A Boss turn can dispatch workers whose write tools need approval. Surface
    // that pending decision inline, on this assistant message, so a chat-only
    // user can approve without leaving the conversation.
    const knownTaskIds = new Set(this.taskService.store.listTasks().map((task) => task.id));
    const unsubscribeApprovalWatch = this.taskService.onChange((changedTaskId) => {
      if (knownTaskIds.has(changedTaskId)) return;
      const changed = this.taskService.store.getTask(changedTaskId);
      if (!changed || changed.state !== 'waiting_approval') return;
      knownTaskIds.add(changedTaskId);
      const current = this.getMessage(record, assistantMessage.id);
      if (!current || current.phase === 'terminal') return;
      // Written for the person reading the conversation, not for an API caller:
      // the client renders the批准/拒绝 controls from `state === 'waiting_approval'`.
      const approvalHint = '【需要你的批准】这一步会修改工作区。请查看上面的改动预览，然后选择批准或拒绝。';
      const body = (current.body ?? '').includes('【需要你的批准】')
        ? current.body
        : [current.body, approvalHint].filter((part) => (part ?? '').trim().length > 0).join('\n\n');
      this.replaceMessage(record, assistantMessage.id, {
        ...current,
        state: 'waiting_approval',
        phase: 'human',
        taskId: changedTaskId,
        body,
        updatedAt: this.now(),
      });
      this.persist(record);
    });
    const onAccepted = (submitted: Awaited<ReturnType<BossModeService['submit']>>) => {
      // Acceptance is not completion: worker tasks may still be running. Record
      // the reply text and keep the message pending so a Boss that hired a
      // worker does not claim "done" while the work is in flight.
      const waiting = submitted.needsAttention === true;
      const failed = submitted.executions.some((execution) => execution.status === 'failed')
        && submitted.hasWorkerOutcome !== true;
      const dispatched = submitted.executions.some((execution) => execution.status === 'created-agent');
      this.replaceMessage(record, assistantMessage.id, {
        ...assistantMessage,
        body: submitted.reply ?? (failed
          ? 'Runtime 执行组织动作时失败。'
          : `已提交 ${submitted.actions.length} 个 Runtime 可验证动作。`),
        state: failed ? 'failed' : waiting ? 'waiting_attention' : dispatched ? 'organizing' : 'done',
        phase: waiting ? 'human' : dispatched ? 'organization' : 'terminal',
        error: failed ? 'Boss Agent execution failed.' : null,
        updatedAt: this.now(),
      });
      this.persist(record);
    };
    /*
     * Whether this Boss turn should let the Boss resolve its own model.
     *
     * It used to be `providerId === 'runtime'`, the virtual pair stored on the
     * record. The record now holds the real model so the catalogue can answer
     * questions about it, so the test is "does the record match the Boss's
     * configured model" — which means the same thing and survives a configured
     * model change. A reader who explicitly picked a different model for the
     * Boss still gets that override.
     */
    const bossDefault = this.bossMode?.modelReference;
    /*
     * A Boss with no configured model keeps its virtual identity on the record,
     * and that record must still mean "let the Boss resolve its own model" —
     * turning it into a `modelOverride` would ask the Boss to route to a
     * provider called `runtime`, which no gateway has heard of.
     */
    const usingBossDefault = record.isBoss && (bossDefault === undefined
      ? record.providerId === BOSS_AGENT_PROVIDER_ID && record.modelId === BOSS_AGENT_MODEL_ID
      : record.providerId === bossDefault.providerId && record.modelId === bossDefault.modelId);
    void bossMode.submit({
        text,
        idempotencyKey: `agent-chat:${record.id}:${idempotencyKey}`,
        conversation,
        ...(record.reasoningEffort.length > 0 ? { reasoningEffort: record.reasoningEffort } : {}),
        ...(usingBossDefault
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
      }, onAccepted).then((settled) => {
        unsubscribeApprovalWatch();
        // The submission settled: worker tasks have been awaited, so the reply
        // can now reflect the real outcome instead of the accepted snapshot.
        const waiting = settled.needsAttention === true;
        const failed = settled.executions.some((execution) => execution.status === 'failed')
          && settled.hasWorkerOutcome !== true;
        this.replaceMessage(record, assistantMessage.id, {
          ...this.getMessage(record, assistantMessage.id)!,
          body: settled.reply ?? this.getMessage(record, assistantMessage.id)!.body,
          state: failed ? 'failed' : waiting ? 'waiting_attention' : 'done',
          phase: waiting ? 'human' : 'terminal',
          error: failed ? 'Boss Agent execution failed.' : null,
          updatedAt: this.now(),
        });
        this.persist(record);
      }).catch((cause: unknown) => {
        unsubscribeApprovalWatch();
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

  /**
   * Read path.
   *
   * Projects pending messages for display only. It deliberately does not call
   * `persist`: a query must not mutate durable state, and the write path already
   * settles terminal outcomes from the task change notification.
   */
  private projectForRead(record: ConversationRecord): AgentChatMessage[] {
    // Lazy settling: the task change bus is asynchronous, so a read that races
    // a just-finished task would otherwise see the previous state. Settling
    // here keeps the record authoritative without making the *projection* a
    // write — the projection itself is still computed below and returned.
    this.settleRecord(record);
    return record.messages.map((message) => {
      const task = message.taskId ? this.taskService.store.getTask(message.taskId) : null;
      const projected = projectMessage({
        message,
        task,
        activity: message.taskId ? this.taskActivity(message.taskId) : [],
        now: this.now(),
      });
      // A terminal message is not re-projected, but its activity still comes
      // from durable events. Rebuild it here so a reopened conversation shows
      // the same turns and tool calls it showed before the restart.
      if (projected === null && message.author === 'assistant' && message.taskId !== null) {
        const activity = this.taskActivity(message.taskId);
        const rebuilt = activity.length > 0 ? Object.freeze({ ...message, activity }) : message;
        return withApprovalExplanation(rebuilt);
      }
      // The projection is returned, not stored: reads never mutate durable state.
      return withApprovalExplanation(projected ?? message);
    });
  }

  private taskActivity(taskId: string): readonly AgentChatActivity[] {
    const events = this.taskService.store.listTaskEvents(taskId);
    const activity: AgentChatActivity[] = [];
    let lastTurn: AgentChatActivity | null = null;
    const byTool = new Map<string, AgentChatActivity[]>();
    for (const event of events) {
      if (event.type === 'agent_loop.turn_started') {
        const iteration = typeof event.data.iteration === 'number' ? event.data.iteration : 0;
        const next: AgentChatActivity = Object.freeze({
          id: `turn-${event.id}`,
          kind: 'turn',
          label: `第 ${iteration + 1} 轮`,
          state: 'running',
          detail: null,
        });
        activity.push(next);
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
        const pending = byTool.get(toolId) ?? [];
        pending.push(next);
        byTool.set(toolId, pending);
        activity.push(next);
      } else if (event.type === 'agent_loop.tool_executed') {
        const toolId = boundedString(event.data.toolId, 'unknown');
        const current = byTool.get(toolId)?.shift();
        if (current) {
          const done = Object.freeze({ ...current, state: 'succeeded' as const });
          const index = activity.findIndex((entry) => entry.id === current.id);
          if (index >= 0) activity[index] = done;
          if (byTool.get(toolId)?.length === 0) byTool.delete(toolId);
        }
      } else if (event.type === 'agent_loop.tool_reused') {
        // The read was served from an earlier identical result. It is
        // still a successful tool activity, but the label says so instead of
        // pretending a new execution happened.
        const toolId = boundedString(event.data.toolId, 'unknown');
        const current = byTool.get(toolId)?.shift();
        const detail = current?.detail ?? toolId;
        const reused: AgentChatActivity = Object.freeze({
          id: current?.id ?? `${event.id}:${toolId}`,
          kind: 'tool',
          label: `${toolLabel(toolId)}（复用）`,
          state: 'succeeded',
          detail,
        });
        if (current) {
          const index = activity.findIndex((entry) => entry.id === current.id);
          if (index >= 0) activity[index] = reused;
          else activity.push(reused);
          if (byTool.get(toolId)?.length === 0) byTool.delete(toolId);
        } else {
          activity.push(reused);
        }
      } else if (event.type === 'agent_loop.tool_failed') {
        const toolId = boundedString(event.data.toolId, 'unknown');
        const current = byTool.get(toolId)?.shift();
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
        if (byTool.get(toolId)?.length === 0) byTool.delete(toolId);
      } else if (event.type === 'agent_loop.approval_requested') {
        const tool = typeof event.data.toolId === 'string' ? event.data.toolId : 'tool';
        const target = typeof event.data.targetPath === 'string' ? event.data.targetPath : null;
        const risk = typeof event.data.risk === 'string' ? event.data.risk : 'write';
        const summary = typeof event.data.previewSummary === 'string' ? event.data.previewSummary : null;
        const diff = typeof event.data.previewDiff === 'string' ? event.data.previewDiff : null;
        activity.push(Object.freeze({
          id: `approval-${event.id}`,
          kind: 'approval',
          label: target ? `等待审批：${tool} → ${target}` : `等待审批：${tool}`,
          state: 'waiting_approval',
          detail: summary ? `${summary}（风险：${risk}）` : `风险：${risk}；可批准或拒绝。`,
        }));
        // The change itself, bounded and already computed by the Runtime, so the
        // client can show what will happen without a second lookup.
        if (summary || diff) {
          activity.push(Object.freeze({
            id: `approval-preview-${event.id}`,
            kind: 'output',
            label: '将要发生的改动',
            state: 'waiting_approval',
            detail: diff ?? summary,
          }));
        }
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

  /**
   * Drops the oldest cached conversation once the cache is over its limit.
   *
   * Both entry points call this: creating a conversation inserts directly, and
   * `load` inserts after a miss. Leaving the check only in `load` meant a
   * service that only created conversations never evicted anything, since the
   * `view()` that follows a create finds the record already cached.
   *
   * A queue lives beside the conversation, so it is evicted with it. A
   * surviving queue would hold a task-change listener for a record nothing
   * references, and a re-loaded conversation would promote turns against a
   * stale queue.
   */
  private evictIfOverCapacity(keep: string): void {
    if (this.conversations.size <= AgentChatService.MAX_CACHED_CONVERSATIONS) return;
    const oldest = this.conversations.keys().next().value;
    if (oldest === undefined || oldest === keep) return;
    this.conversations.delete(oldest);
    this.queuedTurns.delete(oldest);
    this.unwatchQueue(oldest);
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
    this.evictIfOverCapacity(conversationId);
    return record;
  }

  /**
   * Records that the user has now seen this conversation.
   *
   * `done` means "finished and not yet looked at"; `replied` means "finished and
   * seen". Only a read can move one to the other, so the marker is durable and
   * survives restart rather than being a per-process flag.
   */
  private markRead(record: ConversationRecord): void {
    const now = this.now();
    let changed = false;
    for (const message of record.messages) {
      if (message.author !== 'assistant' || message.state !== 'done') continue;
      this.replaceMessage(record, message.id, Object.freeze({ ...message, state: 'replied' }));
      changed = true;
    }
    if (!changed) return;
    // `ConversationRecord` is readonly; persist a copy carrying the new marker
    // rather than mutating the loaded record in place.
    this.persist({ ...record, lastReadAt: now });
  }

  private persist(record: ConversationRecord): void {
    this.store.save({
      ...record,
      messages: Object.freeze([...record.messages]),
      idempotency: Object.freeze([...record.idempotency.entries()].map(([key, value]) =>
        Object.freeze([key, value] as const))),
    });
  }

  /** Releases the task subscription. Call when the service is discarded. */
  close(): void {
    for (const conversationId of [...this.queueWatchers.keys()]) this.unwatchQueue(conversationId);
  }
}
