import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentChatMessage,
  AgentChatMessageAuthor,
  AgentChatMessagePhase,
  AgentChatMessageState,
} from './agent-chat.js';

export interface AgentChatConversationRecord {
  readonly id: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configurationRevisionId: string;
  readonly isBoss: boolean;
  readonly reasoningEffort: 'low' | 'medium' | 'high';
  readonly createdAt: string;
  readonly messages: readonly AgentChatMessage[];
  readonly idempotency: readonly (readonly [string, string])[];
}

export interface AgentChatStore {
  initialize(): void;
  save(record: AgentChatConversationRecord): void;
  get(conversationId: string): AgentChatConversationRecord | null;
  list(limit: number): readonly AgentChatConversationRecord[];
}

const RECOVERED_ERROR = 'Runtime 在本次回复完成前重启，未完成内容已丢弃。';
const NONTERMINAL: readonly AgentChatMessageState[] = Object.freeze([
  'pending', 'thinking', 'streaming', 'organizing',
]);

function recoverMessages(messages: readonly AgentChatMessage[]): readonly AgentChatMessage[] {
  return Object.freeze(messages.map((message) => NONTERMINAL.includes(message.state)
    ? Object.freeze({
      ...message,
      state: 'failed' as const,
      phase: 'terminal' as const,
      progress: null,
      error: RECOVERED_ERROR,
      updatedAt: new Date().toISOString(),
    })
    : message));
}

export class InMemoryAgentChatStore implements AgentChatStore {
  private readonly conversations = new Map<string, AgentChatConversationRecord>();
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const [id, record] of this.conversations) {
      this.conversations.set(id, Object.freeze({
        ...record,
        messages: recoverMessages(record.messages),
      }));
    }
  }

  save(record: AgentChatConversationRecord): void {
    this.conversations.set(record.id, Object.freeze({
      ...record,
      messages: Object.freeze([...record.messages]),
      idempotency: Object.freeze(record.idempotency.map(([key, messageId]) =>
        Object.freeze([key, messageId] as const))),
    }));
  }

  get(conversationId: string): AgentChatConversationRecord | null {
    return this.conversations.get(conversationId) ?? null;
  }

  list(limit: number): readonly AgentChatConversationRecord[] {
    return Object.freeze([...this.conversations.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit));
  }
}

interface ConversationRow {
  readonly id: string;
  readonly agent_id: string;
  readonly agent_revision_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly configuration_revision_id: string;
  readonly is_boss: number;
  readonly reasoning_effort: string;
  readonly created_at: string;
}

interface MessageRow {
  readonly id: string;
  readonly sequence: number;
  readonly author: string;
  readonly body: string;
  readonly state: string;
  readonly task_id: string | null;
  readonly error: string | null;
  readonly phase: string;
  readonly progress: number | null;
  readonly updated_at: string;
  readonly reply_to_id: string | null;
}

interface IdempotencyRow {
  readonly idempotency_key: string;
  readonly message_id: string;
}

function messageFromRow(row: MessageRow): AgentChatMessage {
  const legacyRestart = /Runtime restarted before this reply finished/i.test(row.error ?? '');
  return Object.freeze({
    id: row.id,
    sequence: row.sequence,
    author: row.author as AgentChatMessageAuthor,
    body: row.body,
    state: legacyRestart ? 'failed' : row.state as AgentChatMessageState,
    taskId: row.task_id,
    error: legacyRestart ? RECOVERED_ERROR : row.error,
    phase: row.phase as AgentChatMessagePhase,
    progress: row.progress,
    updatedAt: row.updated_at,
    replyToId: row.reply_to_id,
    activity: Object.freeze([]),
  });
}

export class SqliteAgentChatStore implements AgentChatStore {
  constructor(readonly database: DatabaseSync) {}

  initialize(): void {
    this.database.prepare(`
      UPDATE agent_chat_messages
      SET state = 'failed', phase = 'terminal', progress = NULL, error = ?, updated_at = ?
      WHERE author = 'assistant' AND state IN ('pending', 'thinking', 'streaming', 'organizing')
    `).run(RECOVERED_ERROR, new Date().toISOString());
  }

  save(record: AgentChatConversationRecord): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO agent_chat_conversations (
          id, agent_id, agent_revision_id, provider_id, model_id,
          configuration_revision_id, is_boss, reasoning_effort, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          agent_id = excluded.agent_id,
          agent_revision_id = excluded.agent_revision_id,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          configuration_revision_id = excluded.configuration_revision_id,
          is_boss = excluded.is_boss,
          reasoning_effort = excluded.reasoning_effort
      `).run(
        record.id,
        record.agentId,
        record.agentRevisionId,
        record.providerId,
        record.modelId,
        record.configurationRevisionId,
        record.isBoss ? 1 : 0,
        record.reasoningEffort,
        record.createdAt,
      );
      for (const message of record.messages) {
        this.database.prepare(`
          INSERT INTO agent_chat_messages (
            conversation_id, id, sequence, author, body, state, task_id, error,
            phase, progress, updated_at, reply_to_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id, sequence) DO UPDATE SET
            id = excluded.id,
            author = excluded.author,
            body = excluded.body,
            state = excluded.state,
            task_id = excluded.task_id,
            error = excluded.error,
            phase = excluded.phase,
            progress = excluded.progress,
            updated_at = excluded.updated_at,
            reply_to_id = excluded.reply_to_id
        `).run(
          record.id,
          message.id,
          message.sequence,
          message.author,
          message.body,
          message.state,
          message.taskId,
          message.error,
          message.phase,
          message.progress,
          message.updatedAt,
          message.replyToId,
        );
      }
      for (const [key, messageId] of record.idempotency) {
        this.database.prepare(`
          INSERT INTO agent_chat_idempotency (conversation_id, idempotency_key, message_id)
          VALUES (?, ?, ?)
          ON CONFLICT(conversation_id, idempotency_key) DO UPDATE SET
            message_id = excluded.message_id
        `).run(record.id, key, messageId);
      }
      this.database.exec('COMMIT');
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
  }

  get(conversationId: string): AgentChatConversationRecord | null {
    const conversation = this.database.prepare(`
      SELECT id, agent_id, agent_revision_id, provider_id, model_id,
        configuration_revision_id, is_boss, reasoning_effort, created_at
      FROM agent_chat_conversations WHERE id = ?
    `).get(conversationId) as ConversationRow | undefined;
    if (!conversation) return null;
    const messages = this.database.prepare(`
      SELECT id, sequence, author, body, state, task_id, error, phase, progress, updated_at, reply_to_id
      FROM agent_chat_messages WHERE conversation_id = ? ORDER BY sequence
    `).all(conversationId) as unknown as MessageRow[];
    const idempotency = this.database.prepare(`
      SELECT idempotency_key, message_id
      FROM agent_chat_idempotency WHERE conversation_id = ? ORDER BY rowid
    `).all(conversationId) as unknown as IdempotencyRow[];
    return Object.freeze({
      id: conversation.id,
      agentId: conversation.agent_id,
      agentRevisionId: conversation.agent_revision_id,
      providerId: conversation.provider_id,
      modelId: conversation.model_id,
      configurationRevisionId: conversation.configuration_revision_id,
      isBoss: conversation.is_boss === 1,
      reasoningEffort: (conversation.reasoning_effort as AgentChatConversationRecord['reasoningEffort']) ?? 'medium',
      createdAt: conversation.created_at,
      messages: Object.freeze(messages.map(messageFromRow)),
      idempotency: Object.freeze(idempotency.map((row) =>
        Object.freeze([row.idempotency_key, row.message_id] as const))),
    });
  }

  list(limit: number): readonly AgentChatConversationRecord[] {
    const rows = this.database.prepare(`
      SELECT id FROM agent_chat_conversations ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(limit) as unknown as { readonly id: string }[];
    return Object.freeze(rows.flatMap((row) => {
      const record = this.get(row.id);
      return record ? [record] : [];
    }));
  }
}

export function migrateAgentChatSchema(database: DatabaseSync): void {
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 7) throw new Error(`Database schema version ${version} is newer than this runtime supports.`);
  if (version < 5) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_chat_conversations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_revision_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        configuration_revision_id TEXT NOT NULL,
        is_boss INTEGER NOT NULL CHECK (is_boss IN (0, 1)),
        reasoning_effort TEXT NOT NULL DEFAULT 'medium',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_chat_messages (
        conversation_id TEXT NOT NULL REFERENCES agent_chat_conversations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('user', 'assistant', 'runtime')),
        body TEXT NOT NULL,
        state TEXT NOT NULL,
        task_id TEXT,
        error TEXT,
        phase TEXT NOT NULL,
        progress INTEGER,
        updated_at TEXT NOT NULL,
        reply_to_id TEXT,
        PRIMARY KEY (conversation_id, sequence),
        UNIQUE (conversation_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_chat_idempotency (
        conversation_id TEXT NOT NULL REFERENCES agent_chat_conversations(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, idempotency_key)
      ) STRICT;
    `);
  }
  const columns = database.prepare('PRAGMA table_info(agent_chat_conversations)').all() as unknown as { name: string }[];
  if (!columns.some((column) => column.name === 'reasoning_effort')) {
    database.exec("ALTER TABLE agent_chat_conversations ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'");
  }
}
