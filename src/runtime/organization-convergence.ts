import type { OrganizationAction, OrganizationSnapshot } from './organization-contract.js';
import type { OrganizationStore } from './organization-store.js';
import {
  PROJECT_SUMMARY_VERSION,
  deterministicProjectSummary,
  projectSummaryFacts,
  renderProjectSummary,
  type ProjectSummaryDocument,
  type ProjectSummaryFacts,
} from './project-summary.js';
import type { AgentMemoryStore } from './agent-memory.js';

export const ORGANIZATION_CONVERGENCE_VERSION = 1;

/**
 * Policy for turning a quiet project into an archived one.
 *
 * the implementation accepts the direction (idle -> report -> archive -> offboard) but
 * deliberately left the numbers open. They live here, in one place, so the
 * rule is inspectable and testable instead of being scattered through the
 * service that happens to run first.
 */
export interface ConvergencePolicy {
  /** How long a project may receive no activity before it is a candidate. */
  readonly idleAfterMs: number;
  /** Whether a project with an open attention request may converge at all. */
  readonly convergeWithOpenAttention: boolean;
}

export const DEFAULT_CONVERGENCE_POLICY: ConvergencePolicy = Object.freeze({
  idleAfterMs: 30 * 60 * 1000,
  convergeWithOpenAttention: false,
});

export type ConvergenceSkipReason =
  | 'not-active'
  | 'open-attention'
  | 'recent-activity'
  | 'active-work';

export interface ConvergePlan {
  readonly version: typeof ORGANIZATION_CONVERGENCE_VERSION;
  readonly projectId: string;
  readonly actions: readonly OrganizationAction[];
}

export interface ConvergenceDecision {
  readonly converge: boolean;
  readonly reason?: ConvergenceSkipReason;
  readonly lastActivitySequence: number;
  readonly idleMs: number;
}

/** Signals the Runtime can observe without asking a model anything. */
export interface ProjectActivityInput {
  readonly now: number;
  /**
   * Wall-clock time of the last observed activity. When the caller tracks
   * activity itself (the sweeper does), this is authoritative: deriving it from
   * event sequences alone cannot know when an event happened.
   */
  readonly lastActivityAt?: number;
  /**
   * Wall-clock milliseconds for each event sequence. A missing entry means the
   * event predates clock tracking; such events count as older than the idle
   * window rather than resetting it forever.
   */
  readonly eventTimes?: ReadonlyMap<number, number>;
  /** Event sequence of the last user-authored activity in this project. */
  readonly lastUserActivitySequence?: number;
  /** True while a Task bound to this project is not terminal. */
  readonly hasActiveWork?: boolean;
  readonly policy?: ConvergencePolicy;
}

const PROJECT_ACTIVITY_EVENT_PREFIX = 'organization.';

function lastProjectSequence(snapshot: OrganizationSnapshot, projectId: string): number {
  let last = 0;
  for (const event of snapshot.events) {
    if (event.projectId !== projectId) continue;
    if (!event.type.startsWith(PROJECT_ACTIVITY_EVENT_PREFIX)) continue;
    last = Math.max(last, event.sequence);
  }
  return last;
}

/**
 * Decides whether one project is idle enough to converge.
 *
 * The rule intentionally errs towards doing nothing: an open question, a
 * running task, or any activity inside the window all keep the project alive.
 * Convergence is a destructive-looking transition, so a false negative only
 * delays cleanup while a false positive would archive work the user still
 * wants.
 */
export function decideConvergence(
  snapshot: OrganizationSnapshot,
  projectId: string,
  input: ProjectActivityInput,
): ConvergenceDecision {
  const policy = input.policy ?? DEFAULT_CONVERGENCE_POLICY;
  const project = snapshot.projects.find((item) => item.id === projectId);
  const lastActivitySequence = Math.max(
    lastProjectSequence(snapshot, projectId),
    input.lastUserActivitySequence ?? 0,
  );
  const lastActivityAt = input.lastActivityAt ?? input.eventTimes?.get(lastActivitySequence);
  const idleMs = lastActivityAt === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.now - lastActivityAt);
  const base = { lastActivitySequence, idleMs } as const;
  if (!project || (project.state !== 'active' && project.state !== 'resumed')) {
    return Object.freeze({ converge: false, reason: 'not-active' as const, ...base });
  }
  if (!policy.convergeWithOpenAttention
    && snapshot.attentionRequests.some((request) => request.state === 'open' && request.projectId === projectId)) {
    return Object.freeze({ converge: false, reason: 'open-attention' as const, ...base });
  }
  if (input.hasActiveWork) {
    return Object.freeze({ converge: false, reason: 'active-work' as const, ...base });
  }
  if (idleMs < policy.idleAfterMs) {
    return Object.freeze({ converge: false, reason: 'recent-activity' as const, ...base });
  }
  return Object.freeze({ converge: true, ...base });
}

/**
 * Builds the ordered actions for one convergence.
 *
 * The order matters: the domain rejects archiving a project that still has
 * active workers, so workers are offboarded first, the project is quieted,
 * and only then archived. Reports are not synthesized here — a project summary
 * must describe work that actually happened, so the caller derives it from
 * durable reports rather than inventing one.
 */
export function planConvergence(
  snapshot: OrganizationSnapshot,
  projectId: string,
): ConvergePlan | null {
  const project = snapshot.projects.find((item) => item.id === projectId);
  if (!project || (project.state !== 'active' && project.state !== 'resumed')) return null;
  let sequence = snapshot.events.length;
  const actions: OrganizationAction[] = [];
  for (const worker of snapshot.workers) {
    if (worker.projectId !== projectId) continue;
    if (worker.state === 'offboarded' || worker.state === 'ended') continue;
    actions.push(Object.freeze({
      type: 'offboard_worker' as const,
      expectedSequence: sequence++,
      projectId,
      workerId: worker.id,
    }));
  }
  actions.push(Object.freeze({
    type: 'quiet_project' as const,
    expectedSequence: sequence++,
    projectId,
  }));
  actions.push(Object.freeze({
    type: 'archive_project' as const,
    expectedSequence: sequence++,
    projectId,
  }));
  return Object.freeze({
    version: ORGANIZATION_CONVERGENCE_VERSION,
    projectId,
    actions: Object.freeze(actions),
  });
}


/** A bounded, human-readable summary of what a project produced before it closed. */
export function summarizeProject(
  snapshot: OrganizationSnapshot,
  projectId: string,
  reportTexts?: ReadonlyMap<string, string>,
): string {
  const reports = snapshot.reports.filter((report) => report.projectId === projectId);
  const workers = snapshot.workers.filter((worker) => worker.projectId === projectId);
  const ready = reports.filter((report) => report.state === 'ready').length;
  const failed = reports.filter((report) => report.state === 'failed' || report.state === 'blocked').length;
  const lines = [
    `项目 ${projectId} 已静默收敛：${workers.length} 名员工、${reports.length} 份汇报（成功 ${ready}、失败 ${failed}）。`,
  ];
  for (const report of reports.slice(-5)) {
    const body = reportTexts?.get(report.id);
    const worker = workers.find((item) => item.id === report.workerId);
    const name = worker?.displayName ?? report.workerId;
    const text = body?.trim().slice(0, 240);
    lines.push(text
      ? `- ${name}（${report.state}）：${text}`
      : `- ${name}（${report.state}）：汇报正文未保留`);
  }
  return lines.join('\n');
}

export interface ProjectConvergenceOptions {
  readonly store: OrganizationStore;
  readonly policy?: ConvergencePolicy;
  /** How often the Runtime checks for idle projects. */
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
  /**
   * True while any task bound to the project is still running. Convergence
   * must never archive work that is still executing.
   */
  readonly hasActiveWork?: (projectId: string) => boolean;
  /** Archives the Agent behind an offboarded worker. Best-effort. */
  readonly onWorkerOffboarded?: (workerId: string) => void;
  /**
   * Publishes the short summary into the Boss conversation.
   *
   * Returning a promise lets `sweep()` await delivery. The announcement is
   * best-effort, but a caller that needs to know it landed — a test, or a
   * shutdown that wants a clean hand-off — should not have to poll for it.
   */
  readonly announce?: (summary: string, projectId: string) => void | Promise<void>;
  /**
   * Optional model-backed summary. Returning null (or throwing) falls back to
   * the deterministic summary: convergence must never be blocked by a provider
   * outage, or a finished project would stay active forever.
   */
  readonly summarize?: (facts: ProjectSummaryFacts) => Promise<ProjectSummaryDocument | null>;
  /** Project purpose text, when the caller has it. */
  readonly projectPurpose?: (projectId: string) => string | undefined;
  /**
   * Durable memory. A converged project writes exactly one memory entry so the
   * Boss can recall it later without replaying the event log.
   */
  readonly memory?: AgentMemoryStore;
}

export interface ConvergenceSweepResult {
  readonly converged: readonly { readonly projectId: string; readonly summary: string }[];
}

/**
 * Runs the idle -> report -> archive -> offboard loop that the implementation accepted
 * as a direction.
 *
 * Activity is observed from the durable snapshot itself: a change in a
 * project's event count, report count, worker states, or open attention resets
 * its idle clock. Nothing is inferred from model prose, and a restart cannot
 * archive a project early — an unobserved project simply starts a fresh idle
 * window.
 */
export class ProjectConvergenceService {
  private readonly store: OrganizationStore;
  private readonly policy: ConvergencePolicy;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly hasActiveWork: (projectId: string) => boolean;
  private readonly onWorkerOffboarded: (workerId: string) => void;
  private readonly announce: (summary: string, projectId: string) => void | Promise<void>;
  private readonly summarize: ((facts: ProjectSummaryFacts) => Promise<ProjectSummaryDocument | null>) | undefined;
  private readonly projectPurpose: (projectId: string) => string | undefined;
  private readonly memory: AgentMemoryStore | undefined;
  /** Project id -> { fingerprint, since } for the last observed activity. */
  private readonly observed = new Map<string, { fingerprint: string; since: number }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ProjectConvergenceOptions) {
    this.store = options.store;
    this.policy = options.policy ?? DEFAULT_CONVERGENCE_POLICY;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.hasActiveWork = options.hasActiveWork ?? (() => false);
    this.onWorkerOffboarded = options.onWorkerOffboarded ?? (() => undefined);
    this.announce = options.announce ?? (() => undefined);
    this.summarize = options.summarize;
    this.projectPurpose = options.projectPurpose ?? (() => undefined);
    this.memory = options.memory;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // The tick is async only because the summary may call a model. Failures
      // are contained inside `sweep`, so an unhandled rejection cannot kill the
      // Runtime.
      void this.sweep().catch(() => undefined);
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(): Promise<ConvergenceSweepResult> {
    const snapshot = this.store.get();
    const now = this.now();
    const activeIds = new Set<string>();
    const converged: { projectId: string; summary: string }[] = [];
    const announcements: Promise<void>[] = [];
    for (const project of snapshot.projects) {
      activeIds.add(project.id);
      const fingerprint = this.fingerprint(snapshot, project.id);
      const previous = this.observed.get(project.id);
      if (!previous || previous.fingerprint !== fingerprint) {
        this.observed.set(project.id, { fingerprint, since: now });
        continue;
      }
      const decision = decideConvergence(snapshot, project.id, {
        now,
        lastActivityAt: previous.since,
        policy: this.policy,
        hasActiveWork: this.hasActiveWork(project.id),
      });
      if (!decision.converge) continue;
      const plan = planConvergence(snapshot, project.id);
      if (!plan) continue;
      // Summarize from the pre-convergence snapshot: offboarding changes worker
      // state, and the report must describe the project as it actually ended.
      const document = await this.buildSummary(snapshot, project.id);
      const summary = renderProjectSummary(document);
      try {
        this.store.recordProjectSummary?.(project.id, JSON.stringify(document));
      } catch {
        // Persistence is best-effort here; the archive must still happen.
      }
      this.rememberProject(project.id, summary);
      for (const action of plan.actions) {
        this.store.apply(action);
        if (action.type === 'offboard_worker') this.onWorkerOffboarded(action.workerId);
      }
      this.observed.delete(project.id);
      converged.push({ projectId: project.id, summary });
      announcements.push(Promise.resolve(this.announce(summary, project.id)));
    }
    for (const projectId of [...this.observed.keys()]) {
      if (!activeIds.has(projectId)) this.observed.delete(projectId);
    }
    // Delivery is best-effort: a failed announcement must not fail the sweep,
    // because the archive is already durable and is the source of truth. It is
    // awaited anyway so the caller knows the announcement chain has settled —
    // otherwise "did it land?" is unanswerable without polling.
    await Promise.allSettled(announcements);
    return Object.freeze({ converged: Object.freeze(converged) });
  }

  private rememberProject(projectId: string, summary: string): void {
    if (!this.memory) return;
    try {
      this.memory.write({
        scope: 'project',
        scopeId: projectId,
        key: `project_summary:${projectId}`,
        title: `项目 ${projectId} 已完成并归档`,
        body: summary,
        // Convergence is Runtime-derived. It must never put back a fact the
        // user deleted; the write is rejected by the store when it is a
        // tombstoned key.
        origin: 'automatic',
      });
    } catch {
      // A memory write must never block or undo an archive.
    }
  }

  private async buildSummary(
    snapshot: OrganizationSnapshot,
    projectId: string,
  ): Promise<ProjectSummaryDocument> {
    const facts = projectSummaryFacts(snapshot, projectId, {
      ...(this.projectPurpose(projectId) === undefined
        ? {}
        : { purpose: this.projectPurpose(projectId)! }),
      ...(this.store.reportTexts?.() ? { reportTexts: this.store.reportTexts!() } : {}),
    });
    if (this.summarize) {
      try {
        const generated = await this.summarize(facts);
        if (generated) return generated;
      } catch {
        // Fall through to the deterministic summary.
      }
    }
    return deterministicProjectSummary(facts);
  }

  private fingerprint(snapshot: OrganizationSnapshot, projectId: string): string {
    const events = snapshot.events.filter((event) => event.projectId === projectId);
    const workers = snapshot.workers.filter((worker) => worker.projectId === projectId);
    const reports = snapshot.reports.filter((report) => report.projectId === projectId);
    const attention = snapshot.attentionRequests.filter((request) => request.projectId === projectId);
    return [
      events.length,
      events.at(-1)?.sequence ?? 0,
      workers.map((worker) => `${worker.id}:${worker.state}`).join(','),
      reports.map((report) => `${report.id}:${report.state}`).join(','),
      attention.map((request) => `${request.id}:${request.state}`).join(','),
    ].join('|');
  }
}
