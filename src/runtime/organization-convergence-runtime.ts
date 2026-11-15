import { BOSS_AGENT_ID, type AgentChatService } from './agent-chat.js';
import type { OrganizationSnapshot } from './organization-contract.js';
import type { OrganizationStore } from './organization-store.js';
import type { TaskService } from './task-service.js';
import {
  ProjectConvergenceService,
  type ConvergencePolicy,
  type ProjectConvergenceOptions,
} from './organization-convergence.js';

export interface ConvergenceRuntimeOptions {
  readonly store: OrganizationStore;
  readonly taskService: TaskService;
  readonly agentChat?: AgentChatService;
  readonly policy?: ConvergencePolicy;
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
  readonly onWorkerOffboarded?: (workerId: string) => void;
}

function nonterminal(state: string): boolean {
  return !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
}

/**
 * The set of Task ids currently executing for one project.
 *
 * A Task is linked to its project through the durable
 * `organization.worker_execution_recorded` event. That event is the authority:
 * it is written in the same slice that creates the Task, and it survives
 * restart, unlike an in-process map.
 */
export function projectTaskIds(snapshot: OrganizationSnapshot, projectId: string): readonly string[] {
  const ids: string[] = [];
  for (const event of snapshot.events) {
    if (event.type !== 'organization.worker_execution_recorded') continue;
    if (event.projectId !== projectId) continue;
    const taskId = event.data.taskId;
    if (typeof taskId === 'string') ids.push(taskId);
  }
  return Object.freeze(ids);
}

/** The most recent Boss conversation, if the user has ever opened one. */
export async function latestBossConversation(
  agentChat: AgentChatService,
): Promise<string | undefined> {
  const listed = await agentChat.listConversations(50);
  return listed.conversations.find((conversation) => conversation.agentId === BOSS_AGENT_ID)?.id;
}

export function createConvergenceRuntime(
  options: ConvergenceRuntimeOptions,
): ProjectConvergenceService {
  const service = new ProjectConvergenceService({
    store: options.store,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
    ...(options.now ? { now: options.now } : {}),
    hasActiveWork: (projectId: string) => {
      const snapshot = options.store.get();
      return projectTaskIds(snapshot, projectId).some((taskId) => {
        const task = options.taskService.store.getTask(taskId);
        return Boolean(task && nonterminal(task.state));
      });
    },
    ...(options.onWorkerOffboarded ? { onWorkerOffboarded: options.onWorkerOffboarded } : {}),
    // Announcements are only delivered when the user already has a Boss
    // conversation. Creating one on their behalf would put a message in a
    // place they never opened.
    announce: (summary: string, projectId: string) => {
      const agentChat = options.agentChat;
      if (!agentChat) return;
      // The sweep is synchronous, so the lookup is deferred: the project is
      // already archived and the announcement must not be able to undo that.
      void latestBossConversation(agentChat).then((conversationId) => {
        if (!conversationId) return;
        try {
          agentChat.announceBossNotice({
            conversationId,
            body: summary,
            idempotencyKey: `converge:${projectId}:${hash(summary)}`,
          });
        } catch {
          // The durable organization archive event remains the source of truth.
        }
      }).catch(() => undefined);
    },
  } satisfies ProjectConvergenceOptions);
  return service;
}

function hash(value: string): string {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result.toString(16).padStart(8, '0');
}
