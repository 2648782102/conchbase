/**
 * A small, user-facing view of one project's lifecycle.
 *
 * The organization snapshot already holds the truth; this projection answers the
 * two questions a person actually has: "what state is this in?" and "what can I
 * do next?" without exposing the internal action vocabulary.
 */
import type { OrganizationSnapshot, ProjectState } from './organization-contract.js';

export interface ProjectLifecycleView {
  readonly projectId: string;
  readonly state: ProjectState;
  readonly summary: string;
  /** Short, plain-language next step, or null when the user need do nothing. */
  readonly nextAction: string | null;
  readonly openAttention: number;
  readonly activeWorkers: number;
}

const NEXT_ACTION: Record<ProjectState, string | null> = {
  forming: '确认项目目标，然后启动它',
  active: '等待员工汇报，或补充要求',
  quiet: '项目暂时空闲；可以归档，或继续提新需求',
  resumed: '项目已恢复，等待员工继续',
  archived: '项目已归档；如需继续，先恢复它',
  stopped: '项目已停止；如需继续，先恢复它',
};

export function projectLifecycleView(
  snapshot: OrganizationSnapshot,
  projectId: string,
): ProjectLifecycleView | null {
  const project = snapshot.projects.find((item) => item.id === projectId);
  if (!project) return null;
  const openAttention = snapshot.attentionRequests.filter((request) =>
    request.projectId === projectId && request.state === 'open').length;
  const activeWorkers = snapshot.workers.filter((worker) =>
    worker.projectId === projectId
    && ['authorized', 'running', 'idle', 'reporting'].includes(worker.state)).length;
  return Object.freeze({
    projectId,
    state: project.state,
    summary: `项目 ${projectId} 状态：${project.state}；${activeWorkers} 名员工，${openAttention} 条待处理。`,
    nextAction: openAttention > 0 ? '先回答待处理的 Attention' : NEXT_ACTION[project.state],
    openAttention,
    activeWorkers,
  });
}
