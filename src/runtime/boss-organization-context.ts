import type {
  AttentionRequest,
  Delegation,
  OrganizationReport,
  OrganizationSnapshot,
  OrganizationWorker,
  Project,
} from './organization-contract.js';

export interface BossCapabilityFact {
  readonly id: string;
  readonly available: boolean;
  readonly description: string;
}

export interface BossProjectFact {
  readonly id: string;
  readonly state: Project['state'];
  readonly purpose: string;
  readonly originIntent: string;
}

export interface BossWorkerFact {
  readonly id: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly state: OrganizationWorker['state'];
  readonly instructions: string;
  readonly scope: readonly string[];
  readonly capabilities: readonly string[];
  readonly model: OrganizationWorker['model'];
}

export interface BossDelegationFact {
  readonly id: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly scope: readonly string[];
  readonly capabilities: readonly string[];
  readonly state: Delegation['state'];
  readonly expiresAtSequence: number;
}

export interface BossReportFact {
  readonly id: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly state: OrganizationReport['state'];
  readonly summaryDigest: string;
}

export interface BossAttentionFact {
  readonly id: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly state: AttentionRequest['state'];
  readonly questionDigest: string;
}

export interface BossOrganizationFacts {
  readonly bossSessionId: string;
  readonly projects: readonly BossProjectFact[];
  readonly workers: readonly BossWorkerFact[];
  readonly delegations: readonly BossDelegationFact[];
  readonly reports: readonly BossReportFact[];
  readonly attention: readonly BossAttentionFact[];
  readonly capabilities: readonly BossCapabilityFact[];
}

export interface BuildBossOrganizationFactsInput {
  readonly snapshot: OrganizationSnapshot;
  readonly intentTexts?: ReadonlyMap<string, string>;
  readonly agentInstructions?: (worker: OrganizationWorker) => string | undefined;
}

const DEFAULT_CAPABILITIES: readonly BossCapabilityFact[] = Object.freeze([
  Object.freeze({ id: 'organization', available: true, description: '项目、员工、委派、汇报、Attention、归档与恢复' }),
  Object.freeze({ id: 'agent-chat', available: true, description: '当前对话模型与已有对话上下文' }),
  Object.freeze({ id: 'external-web', available: false, description: '网页搜索、联网读取与实时外部信息' }),
  Object.freeze({ id: 'local-files', available: false, description: '本机文件、设备查询与命令执行' }),
  Object.freeze({ id: 'external-write', available: false, description: '外部系统写入与真实工具执行' }),
]);

const PURPOSE_FALLBACK = '尚未记录明确目标；请根据项目 ID 与来源意图继续了解。';
const INSTRUCTION_FALLBACK = '尚未读取到该员工的指令摘要。';
const MAX_TEXT = 600;

function bounded(value: string | undefined, fallback: string): string {
  const candidate = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (candidate.length === 0) return fallback;
  if (/sk-|Bearer|ghp_|github_pat_|password|apiKey|privateKey|\.conchbase\/|runtime\.sqlite/i.test(candidate)) {
    return fallback;
  }
  return candidate.slice(0, MAX_TEXT);
}

export function buildBossOrganizationFacts(
  input: BuildBossOrganizationFactsInput,
): BossOrganizationFacts {
  const intentTexts = input.intentTexts ?? new Map<string, string>();
  return Object.freeze({
    bossSessionId: input.snapshot.bossSession.id,
    projects: Object.freeze(input.snapshot.projects.map((project) => Object.freeze({
      id: project.id,
      state: project.state,
      purpose: bounded(intentTexts.get(project.originTriggerId), PURPOSE_FALLBACK),
      originIntent: bounded(intentTexts.get(project.originTriggerId), '来源意图未在当前进程内保留。'),
    }))),
    workers: Object.freeze(input.snapshot.workers.map((worker) => Object.freeze({
      id: worker.id,
      projectId: worker.projectId,
      displayName: worker.displayName,
      state: worker.state,
      instructions: bounded(input.agentInstructions?.(worker), INSTRUCTION_FALLBACK),
      scope: Object.freeze([...input.snapshot.delegations
        .find((delegation) => delegation.id === worker.delegationId)?.scope ?? []]),
      capabilities: Object.freeze([...input.snapshot.delegations
        .find((delegation) => delegation.id === worker.delegationId)?.capabilities ?? []]),
      model: worker.model,
    }))),
    delegations: Object.freeze(input.snapshot.delegations.map((delegation) => Object.freeze({
      id: delegation.id,
      projectId: delegation.projectId,
      workerId: delegation.workerId,
      scope: delegation.scope,
      capabilities: delegation.capabilities,
      state: delegation.state,
      expiresAtSequence: delegation.expiresAtSequence,
    }))),
    reports: Object.freeze(input.snapshot.reports.map((report) => Object.freeze({
      id: report.id,
      projectId: report.projectId,
      workerId: report.workerId,
      state: report.state,
      summaryDigest: report.summaryDigest,
    }))),
    attention: Object.freeze(input.snapshot.attentionRequests.map((request) => Object.freeze({
      id: request.id,
      projectId: request.projectId,
      workerId: request.workerId,
      state: request.state,
      questionDigest: request.questionDigest,
    }))),
    capabilities: DEFAULT_CAPABILITIES,
  });
}
