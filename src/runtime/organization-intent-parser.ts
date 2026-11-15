import { createHash } from 'node:crypto';
import { repairActionFields } from './organization-action-contract.js';
import {
  createOrganization,
  parseOrganizationAction,
  type OrganizationAction,
  type OrganizationSnapshot,
} from './organization-contract.js';
import { chineseAgentDisplayName } from './agent-name.js';
import type { BossOrganizationFacts } from './boss-organization-context.js';
import { containsSecretLike } from './secret-filter.js';

export const ORGANIZATION_INTENT_PARSER_VERSION = 1;

export class OrganizationIntentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationIntentParseError';
  }
}

export interface OrganizationIntentParserInput {
  readonly intentId: string;
  readonly text: string;
  readonly expectedSequence: number;
  readonly signal?: AbortSignal;
  readonly snapshot?: OrganizationSnapshot;
  readonly modelReference?: { readonly providerId: string; readonly modelId: string };
  readonly conversation?: readonly {
    readonly author: 'user' | 'assistant';
    readonly body: string;
  }[];
  readonly organizationFacts?: BossOrganizationFacts;
  readonly onProgress?: (progress: BossConversationProgress) => void;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface BossConversationProgress {
  readonly state: 'streaming';
  readonly percent: number;
  readonly previousText?: string;
}

export interface OrganizationIntentParseResult {
  readonly version: typeof ORGANIZATION_INTENT_PARSER_VERSION;
  readonly intentId: string;
  readonly actions: readonly OrganizationAction[];
  readonly relay: string | null;
}

export interface OrganizationIntentParser {
  parse(input: OrganizationIntentParserInput): Promise<OrganizationIntentParseResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function reference(value: string, length = 24): string {
  return digest(value).slice(0, length);
}

function boundedDigest(value: string): string {
  return `sha256:${digest(value)}`;
}

function actionAt(action: OrganizationAction, expectedSequence: number): OrganizationAction {
  return Object.freeze({ ...action, expectedSequence }) as OrganizationAction;
}

export function parseStructuredOrganizationResult(
  input: OrganizationIntentParserInput,
  value: unknown,
): OrganizationIntentParseResult {
  if (!isRecord(value)) throw new OrganizationIntentParseError('Structured adapter output must be an object.');
  const rawActions = value.actions;
  if (!Array.isArray(rawActions) || rawActions.length > 16) {
    throw new OrganizationIntentParseError('Structured adapter must return at most 16 actions.');
  }
  const baseSequence = input.snapshot?.events.length ?? input.expectedSequence;
  const actions = rawActions.map((candidate, index) => {
    const normalized = Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).type === 'open_project'
      ? { ...(candidate as Record<string, unknown>), originTriggerId: input.intentId }
      : candidate;
    // ADR 0074: the Runtime owns `expectedSequence`, so fill it before
    // validation. Validating first would reject a plan for omitting a value the
    // model cannot compute.
    const withSequence = isRecord(normalized)
      ? { ...normalized, expectedSequence: baseSequence + index }
      : normalized;
    return actionAt(
      parseOrganizationAction(repairRawAction(withSequence, baseSequence + index, input.modelReference)),
      baseSequence + index,
    );
  });
  const relay = value.relay === null || value.relay === undefined ? null : value.relay;
  if (relay !== null && (typeof relay !== 'string' || relay.length > 2000)) {
    throw new OrganizationIntentParseError('Structured adapter relay is not bounded.');
  }
  if (containsSecretLike(relay)) {
    throw new OrganizationIntentParseError('Structured adapter relay contains secret-like content.');
  }
  return Object.freeze({
    version: ORGANIZATION_INTENT_PARSER_VERSION,
    intentId: input.intentId,
    actions: Object.freeze(actions),
    relay,
  });
}

/**
 * Repairs one raw action using the shared contract table. Validation still
 * happens afterwards; this only ensures the Runtime supplies what only it can
 * know, so a model is never rejected for omitting an opaque id, a digest, the
 * event sequence, or a structural default.
 */
function repairRawAction(
  value: unknown,
  sequence: number,
  model?: { readonly providerId: string; readonly modelId: string },
): unknown {
  if (!isRecord(value)) return value;
  return repairActionFields(value, sequence, model ? { model } : {});
}

export function parseBossConversationResult(
  input: OrganizationIntentParserInput,
  value: unknown,
): OrganizationIntentParseResult {
  if (!isRecord(value)) throw new OrganizationIntentParseError('Boss conversation output must be an object.');
  const unknown = Object.keys(value).filter((key) => !['reply', 'actions'].includes(key));
  if (unknown.length > 0) {
    throw new OrganizationIntentParseError(`Boss conversation output has unknown fields: ${unknown.sort().join(', ')}.`);
  }
  const reply = value.reply;
  if (typeof reply !== 'string' || reply.trim().length === 0 || reply.length > 12_000) {
    throw new OrganizationIntentParseError('Boss conversation reply is not bounded.');
  }
  const boundedReply = normalizeBossReply(reply);
  if (containsSecretLike(boundedReply)) {
    throw new OrganizationIntentParseError('Boss conversation reply contains secret-like content.');
  }
  const rawActions = value.actions;
  if (!Array.isArray(rawActions) || rawActions.length > 16) {
    throw new OrganizationIntentParseError('Boss conversation must return at most 16 actions.');
  }
  const baseSequence = input.snapshot?.events.length ?? input.expectedSequence;
  const actions = rawActions.map((candidate, index) => {
    const projected = projectActionFields(repairRawAction(candidate, input.expectedSequence, input.modelReference));
    const withOrigin = Boolean(projected) && typeof projected === 'object' && !Array.isArray(projected)
      && (projected as Record<string, unknown>).type === 'create_agent'
      ? normalizeCreateAgentModel(
        projected as Record<string, unknown>,
        input.modelReference,
      )
      : projected;
    const normalized = Boolean(projected) && typeof projected === 'object' && !Array.isArray(projected)
      && (projected as Record<string, unknown>).type === 'open_project'
      ? { ...(withOrigin as Record<string, unknown>), originTriggerId: input.intentId }
      : withOrigin;
    const withSequence = isRecord(normalized)
      ? { ...normalized, expectedSequence: baseSequence + index }
      : normalized;
    return actionAt(parseOrganizationAction(withSequence), baseSequence + index);
  });
  return Object.freeze({
    version: ORGANIZATION_INTENT_PARSER_VERSION,
    intentId: input.intentId,
    actions: Object.freeze(actions),
    relay: boundedReply,
  });
}

function normalizeCreateAgentModel(
  candidate: Record<string, unknown>,
  fallback: { readonly providerId: string; readonly modelId: string } | undefined,
): Record<string, unknown> {
  const model = candidate.model;
  const valid = Boolean(model) && typeof model === 'object' && !Array.isArray(model)
    && typeof (model as Record<string, unknown>).providerId === 'string'
    && typeof (model as Record<string, unknown>).modelId === 'string';
  if (valid) return candidate;
  if (!fallback) return candidate;
  return { ...candidate, model: fallback };
}

const ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  open_project: ['type', 'expectedSequence', 'projectId', 'originTriggerId'],
  record_intent: ['type', 'expectedSequence', 'projectId', 'intentId', 'bodyDigest', 'actionCount'],
  activate_project: ['type', 'expectedSequence', 'projectId'],
  create_agent: [
    'type', 'expectedSequence', 'projectId', 'workerId', 'delegationId', 'parentDelegationId',
    'agentRevisionId', 'displayName', 'instructionsDigest', 'scope', 'capabilities', 'model',
    'maxDelegationDepth', 'ttlEvents', 'instructions',
  ],
  authorize_worker: ['type', 'expectedSequence', 'projectId', 'workerId'],
  start_worker: ['type', 'expectedSequence', 'projectId', 'workerId'],
  report_worker: ['type', 'expectedSequence', 'projectId', 'workerId', 'reportId', 'state', 'summaryDigest'],
  request_attention: ['type', 'expectedSequence', 'projectId', 'workerId', 'attentionId', 'questionDigest'],
  answer_attention: ['type', 'expectedSequence', 'projectId', 'attentionId', 'decisionDigest'],
  withdraw_attention: ['type', 'expectedSequence', 'projectId', 'attentionId', 'decisionDigest'],
  expire_attention: ['type', 'expectedSequence', 'projectId', 'attentionId', 'decisionDigest'],
  quiet_project: ['type', 'expectedSequence', 'projectId'],
  archive_project: ['type', 'expectedSequence', 'projectId'],
  resume_project: ['type', 'expectedSequence', 'projectId', 'revalidatedDelegationId'],
  offboard_worker: ['type', 'expectedSequence', 'projectId', 'workerId'],
  activate_delegation: ['type', 'expectedSequence', 'projectId', 'delegationId'],
  record_worker_execution: ['type', 'expectedSequence', 'projectId', 'workerId', 'taskId', 'workItemId', 'agentId'],
  resume_worker: ['type', 'expectedSequence', 'projectId', 'workerId'],
});

function projectActionFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const type = value.type;
  if (typeof type !== 'string') return value;
  const allowed = ACTION_FIELDS[type];
  if (!allowed) return value;
  const projected: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in value) projected[key] = value[key];
  }
  return projected;
}

export function normalizeBossReply(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const hasUnsupportedClaim = /查(?:网页|网络|联网)|本机文件|读取.{0,8}文件|执行.{0,8}命令|腾讯混元|腾讯\s*Hy|\bHy\b/i.test(text);
  const hasFalseIdentity = /腾讯混元|腾讯\s*Hy|\bHy\b/i.test(text);
  let normalized = text;
  if (hasFalseIdentity) {
    normalized = normalized
      .replace(/我是[^。！？\n]{0,40}(?:腾讯混元|腾讯\s*Hy|\bHy\b)[^。！？\n]*[。！？]?/gi, '我是 Conchbase 的老板 Agent。')
      .replace(/(?:底层)?模型是[^。！？\n]*(?:腾讯混元|腾讯\s*Hy|\bHy\b)[^。！？\n]*[。！？]?/gi, '');
  }
  if (hasUnsupportedClaim) {
    normalized = normalized
      .replace(/我可以[^。！？\n]{0,40}(?:查网页|联网|读取.{0,8}文件|本机文件)[^。！？\n]*[。！？]?/gi,
        '我当前没有网页搜索、本机文件或设备查询能力；这些能力尚未接入 Runtime。')
      .replace(/我能[^。！？\n]{0,40}(?:查网页|联网|读取.{0,8}文件|本机文件)[^。！？\n]*[。！？]?/gi,
        '我当前没有网页搜索、本机文件或设备查询能力；这些能力尚未接入 Runtime。');
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

const parseStructuredResult = parseStructuredOrganizationResult;

function projectName(text: string): string {
  const match = /\b(?:project|项目)\s*[“"'：:]?\s*([A-Za-z0-9][A-Za-z0-9 _-]{1,48})/i.exec(text);
  return (match?.[1] ?? 'primary initiative').trim().replace(/\s+/g, '-').toLowerCase();
}

function workerName(text: string, project: string): string | null {
  const match = /\b(?:worker|employee|员工|招聘|hire)\s*[“"'：:]?\s*([A-Za-z0-9][A-Za-z0-9 _-]{1,48})/i.exec(text);
  return match ? (match[1] ?? `${project}-worker`).trim().replace(/\s+/g, '-').toLowerCase() : null;
}

export function createDeterministicOrganizationIntentParser(): OrganizationIntentParser {
  return {
    async parse(input) {
      const text = input.text.trim();
      if (text.length === 0) throw new OrganizationIntentParseError('Intent text must not be empty.');
      if (containsSecretLike(text)) {
        throw new OrganizationIntentParseError('Intent text contains secret-like content.');
      }
      const snapshot = input.snapshot ?? createOrganization('primary_conversation');
      const modelReference = input.modelReference ?? { providerId: 'magpie', modelId: 'fixture-model' };
      const requestedName = projectName(text);
      const wantsLifecycle = /\barchive|归档|offboard|裁掉|resume|恢复|重启项目\b/i.test(text);
      const lifecycleProject = wantsLifecycle
        ? snapshot.projects.find((item) => /\barchive|归档|offboard|裁掉\b/i.test(text)
          ? item.state === 'active' || item.state === 'resumed' || item.state === 'quiet'
          : item.state === 'archived')
        : undefined;
      const name = lifecycleProject?.id ?? requestedName;
      const projectId = name.startsWith('project_') ? name : `project_${reference(name)}`;
      const project = snapshot.projects.find((item) => item.id === projectId);
      const worker = workerName(text, name);
      const workerId = worker ? `wrk_${reference(`worker:${name}:${worker}`)}` : undefined;
      const wantsResume = /\bresume|恢复|重启项目\b/i.test(text);
      const wantsArchive = /\barchive|归档|offboard|裁掉\b/i.test(text);
      const wantsAttention = /\battention|need (?:input|help)|需要(?:确认|输入|帮助)\b/i.test(text);
      const wantsAnswer = /\banswer|回答|确认(?:完成|继续)\b/i.test(text);
      const actions: OrganizationAction[] = [];
      let sequence = snapshot.events.length;

      if (wantsResume && project?.state === 'archived') {
        const delegation = snapshot.delegations.find((item) => item.projectId === projectId);
        actions.push(parseOrganizationAction({
          type: 'resume_project',
          expectedSequence: sequence++,
          projectId,
          revalidatedDelegationId: delegation?.id ?? 'del_unknown',
        }));
        return parseStructuredResult(input, { actions, relay: '项目恢复动作已提交。' });
      }
      if (wantsArchive && project && project.state !== 'archived') {
        actions.push(parseOrganizationAction({
          type: 'archive_project',
          expectedSequence: sequence++,
          projectId,
        }));
        return parseStructuredResult(input, { actions, relay: '项目归档动作已提交。' });
      }
      if (wantsAnswer) {
        const attention = snapshot.attentionRequests.find((item) => item.state === 'open');
        if (attention) {
          actions.push(parseOrganizationAction({
            type: 'answer_attention',
            expectedSequence: sequence++,
            projectId: attention.projectId,
            attentionId: attention.id,
            decisionDigest: boundedDigest(`answer:${text}`),
          }));
        }
        return parseStructuredResult(input, { actions, relay: actions.length ? 'Attention 已回答。' : '当前没有待处理 Attention。' });
      }
      if (!project) {
        actions.push(parseOrganizationAction({
          type: 'open_project',
          expectedSequence: sequence++,
          projectId,
          originTriggerId: input.intentId,
        }));
        actions.push(parseOrganizationAction({
          type: 'activate_project',
          expectedSequence: sequence++,
          projectId,
        }));
      }
      if (workerId && worker && !snapshot.workers.some((item) => item.id === workerId)) {
        actions.push(parseOrganizationAction({
          type: 'create_agent',
          expectedSequence: sequence++,
          projectId,
          workerId,
          delegationId: `del_${reference(`delegation:${workerId}`)}`,
          agentRevisionId: `agr_${reference(`revision:${workerId}`)}`,
          displayName: chineseAgentDisplayName(worker),
          instructionsDigest: boundedDigest(`dynamic instructions for ${worker} on ${name}`),
          scope: [`project:${name}`],
          capabilities: ['cap_read_context'],
          model: modelReference,
          maxDelegationDepth: 0,
          ttlEvents: 100,
        }));
        actions.push(parseOrganizationAction({
          type: 'start_worker',
          expectedSequence: sequence++,
          projectId,
          workerId,
        }));
      }
      if (wantsAttention && workerId) {
        actions.push(parseOrganizationAction({
          type: 'request_attention',
          expectedSequence: sequence++,
          projectId,
          workerId,
          attentionId: `att_${reference(`attention:${input.intentId}`)}`,
          questionDigest: boundedDigest(`attention:${text}`),
        }));
      }
      if (actions.length === 0) {
        return parseStructuredResult(input, { actions, relay: '意图已收到；项目与员工状态无需变化。' });
      }
      return parseStructuredResult(input, {
        actions,
        relay: `已形成 ${actions.length} 个 Runtime 可验证动作。`,
      });
    },
  };
}

export interface StructuredModelCall {
  readonly model: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export interface StructuredModelClient {
  completeJson(input: StructuredModelCall): Promise<string>;
}

const OPENAI_COMPATIBLE_PARSER_INSTRUCTIONS = [
  'You are the Conchbase organization intent parser.',
  'Return only strict JSON with this shape: {"actions":[],"relay":string|null}.',
  'Each actions item must be an object whose type is exactly one of open_project, activate_project, create_agent, authorize_worker, start_worker, report_worker, request_attention, answer_attention, withdraw_attention, quiet_project, archive_project, resume_project, offboard_worker, record_intent, activate_delegation, record_worker_execution, resume_worker.',
  'Use snake_case action types only. Never turn a phrase into a camelCase or PascalCase action type.',
  'Always include a string projectId. Do not include expectedSequence: the Runtime supplies it, and a value you supply is ignored.',
  'For create_agent also include workerId, delegationId, agentRevisionId, displayName, instructionsDigest, scope, capabilities, model, maxDelegationDepth, ttlEvents.',
  'Never invent capabilities, secret values, file paths, URLs, or role enums.',
  'If the user text cannot be represented exactly by accepted actions, return {"actions":[],"relay":"No safe structured action."}.',
].join(' ');

const BOSS_CONVERSATION_INSTRUCTIONS = [
  '你是 Conchbase 的老板 Agent，和用户进行自然、清楚、有帮助的中文对话。',
  '你拥有组织项目、招聘员工、汇报、归档、恢复等能力，但只有在用户目标确实需要时才主动使用；普通聊天、分析、建议和追问不要产生动作。',
  '能力提升来自 Runtime；你只能提出建议动作，不能直接执行、不能授权、不能读取密钥或文件。',
  'Return only strict JSON with exactly two fields: {"reply":string,"actions":[]}.',
  'reply 是面向用户的自然语言回复，可以解释建议、说明已准备的动作或提出下一步问题，不要暴露内部推理。',
  '铁律：下“不存在/没有/查不到”这类否定结论之前，必须先读完组织事实里已有字段（尤其 reports 的 summary 与 state、workers、projects）。只能说“我在 X 范围内没看到 Y”，不能断言“系统里没有 Y”。',
  '引用员工汇报时，若 reports[].summary 非空就原样引用并标注 reportId；只有 summary 确实为空时才说未保留。禁止把“我看到的摘要”说成“正文不存在”。',
  '回复要短：先给一句话结论，再给必要证据（ID + 状态 + 关键原文），原文超过 3 行就截断并注明已截断，最后给 1–3 个下一步选项；避免重复同一结论。',
  '员工失败要分类处置：迭代超限说明任务范围过大或需要更明确的输出格式；计费/额度类错误（如 HTTP 402）不要自动重跑，直接告知用户处理。',
  '员工管理：同类任务优先复用或重跑现有员工；连续两次 failed 先考虑下线该员工而不是再招一个同名近似的新员工。',
  '每个项目最多保留 4 个未下线员工；超出时 Runtime 会拒绝创建，必须先复用现有员工或 offboard_worker 下线旧员工。',
  'actions 中的每项必须是受支持的组织动作对象；type 使用 snake_case，且必须包含 expectedSequence 与 projectId。',
  '动作类型只允许 open_project, activate_project, create_agent, authorize_worker, start_worker, report_worker, request_attention, answer_attention, withdraw_attention, quiet_project, archive_project, resume_project, offboard_worker, record_intent, activate_delegation, record_worker_execution, resume_worker。',
  '当用户提出一个新目标、且现有项目都不匹配时，你可以用 open_project 新建项目：自行生成一个稳定的 projectId（例如 project_<小写短标识>），originTriggerId 使用本次 intentId；随后用 activate_project 启用它。不要声称你不能新建项目。',
  '不要输出 expectedSequence：该字段由 Runtime 提供并按动作顺序填好，你输出的值会被忽略。每个动作必须带 string projectId。',
  'For create_agent include workerId, delegationId, agentRevisionId, displayName, instructionsDigest, scope, capabilities, model, maxDelegationDepth, ttlEvents. Runtime replaces model references.',
  'create_agent 还支持可选 instructions 字段：把用户对该员工的输出格式、长度、禁止项等要求原文写进去，它会成为该员工的系统指令。用户提了格式要求却没传 instructions，就等于没有约束。',
  'Never invent capabilities, secret values, private paths, URLs, role enums, or extra top-level fields.',
  'If no organization action is useful, return {"reply":"你的自然回复","actions":[]}.',
  '你的产品身份始终是 Conchbase Runtime 拥有的老板 Agent；不要声称自己是某个底层模型或供应商。',
  '你没有网页搜索、联网读取、本机文件、设备查询或命令执行能力；除非 Runtime 明确提供，否则不要声称可以做到。',
].join(' ');

export function createOpenAiCompatibleOrganizationIntentParser(options: {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): OrganizationIntentParser {
  const base = options.baseUrl.replace(/\/+$/, '');
  const endpoint = `${base}/v1/chat/completions`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream, application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Conchbase/1.0.0',
  };
  if (options.appKey) headers.Authorization = `Bearer ${options.appKey}`;

  return {
    async parse(input) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            model: options.model,
            stream: true,
            ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
            messages: [
              { role: 'system', content: OPENAI_COMPATIBLE_PARSER_INSTRUCTIONS },
              {
                role: 'user',
                content: JSON.stringify({
                  intentId: input.intentId,
                  text: input.text,
                  expectedSequence: input.expectedSequence,
                  projectIds: (input.snapshot?.projects ?? []).map((project) => project.id),
                  workerIds: (input.snapshot?.workers ?? []).map((worker) => worker.id),
                  openAttentionIds: (input.snapshot?.attentionRequests ?? [])
                    .filter((request) => request.state === 'open')
                    .map((request) => request.id),
                  organization: input.organizationFacts ?? null,
                }),
              },
            ],
          }),
        });
      } catch (cause) {
        if (input.signal?.aborted) throw cause;
        throw new OrganizationIntentParseError('Model provider request failed.');
      }
      if (!response.ok) throw new OrganizationIntentParseError(`Model provider returned HTTP ${response.status}.`);
      // The request asks for `stream: true`, so a conforming upstream answers
      // with text/event-stream. Reading such a body with `response.json()`
      // fails on the first `data:` line. Honour the response's own content type
      // instead of assuming the format from the request.
      const isStreamed = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
      let content: unknown;
      if (isStreamed) {
        content = await readStructuredStream(response);
      } else {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new OrganizationIntentParseError('Model provider returned invalid JSON.');
        }
        content = (payload as {
          choices?: readonly { message?: { content?: unknown } }[];
        })?.choices?.[0]?.message?.content;
      }
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new OrganizationIntentParseError('Model provider returned an empty completion.');
      }
      let structured: unknown;
      try {
        structured = JSON.parse(content);
      } catch {
        throw new OrganizationIntentParseError('Model output is not valid JSON.');
      }
      return parseStructuredResult(input, structured);
    },
  };
}

export function createOpenAiCompatibleBossConversationParser(options: {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}): OrganizationIntentParser {
  const base = options.baseUrl.replace(/\/+$/, '');
  const endpoint = `${base}/v1/chat/completions`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Conchbase/1.0.0',
  };
  if (options.appKey) headers.Authorization = `Bearer ${options.appKey}`;

  const requestOnce = async (
    input: OrganizationIntentParserInput,
    attempt: number,
  ): Promise<string> => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const stream = attempt === 1;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: input.modelReference?.modelId ?? options.model,
          stream,
          messages: [
            { role: 'system', content: BOSS_CONVERSATION_INSTRUCTIONS },
            ...(attempt > 1
              ? [{
                role: 'system' as const,
                content: '上一次回复不是严格 JSON，本次回复未采用。这次必须只输出一个 JSON 对象，形如 {"reply":"...","actions":[]}，不要包含任何解释、前缀、Markdown 代码围栏或注释。',
              }]
              : []),
            {
              role: 'user',
              content: JSON.stringify({
                intentId: input.intentId,
                text: input.text,
                expectedSequence: input.expectedSequence,
                最近对话: (input.conversation ?? []).slice(-8).map((message) => ({
                  author: message.author,
                  body: message.body.slice(0, 2000),
                })),
                projectIds: (input.snapshot?.projects ?? []).map((project) => project.id),
                workerIds: (input.snapshot?.workers ?? []).map((worker) => worker.id),
                openAttentionIds: (input.snapshot?.attentionRequests ?? [])
                  .filter((request) => request.state === 'open')
                  .map((request) => request.id),
                organization: input.organizationFacts ?? null,
              }),
            },
          ],
        }),
      });
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
      throw new OrganizationIntentParseError('Boss model provider request failed; upstream is unavailable.');
    }
    if (!response.ok) {
      throw new OrganizationIntentParseError(`Boss model provider returned HTTP ${response.status}; upstream is unavailable.`);
    }
    const isStreamed = response.headers.get('content-type')?.includes('text/event-stream');
    const content = isStreamed
      ? await readBossStream(response, input.onProgress)
      : await readBossJson(response);
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new OrganizationIntentParseError('Boss model provider returned an empty completion.');
    }
    return content;
  };

  return {
    async parse(input) {
      let fallbackSource: string | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const content = await requestOnce(input, attempt);
        let structured: unknown;
        let usable = false;
        try {
          structured = JSON.parse(extractJsonObject(content));
          usable = isRecord(structured)
            && Array.isArray(structured.actions)
            && typeof structured.reply === 'string';
        } catch {
          usable = false;
        }
        if (usable) {
          return parseBossConversationResult(input, structured);
        }
        if (fallbackSource === null) fallbackSource = content;
        if (attempt < maxAttempts) {
          input.onProgress?.({ state: 'streaming', percent: 0, previousText: '' });
        }
      }
      return parseBossPlainTextFallback(input, fallbackSource ?? '');
    },
  };
}

export function parseBossPlainTextFallback(
  input: OrganizationIntentParserInput,
  content: string,
): OrganizationIntentParseResult {
  const text = content
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (text.length === 0) {
    throw new OrganizationIntentParseError('Boss model output is not valid JSON.');
  }
  if (/^\{\s*"reply"\s*:/.test(text)) {
    throw new OrganizationIntentParseError('Boss model output is not valid JSON.');
  }
  const bounded = normalizeBossReply(text.slice(0, 8_000));
  if (containsSecretLike(bounded)) {
    throw new OrganizationIntentParseError('Boss conversation reply contains secret-like content.');
  }
  return Object.freeze({
    version: ORGANIZATION_INTENT_PARSER_VERSION,
    intentId: input.intentId,
    actions: Object.freeze([]),
    relay: bounded,
  });
}

export function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function readBossJson(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OrganizationIntentParseError('Boss model provider returned invalid JSON.');
  }
  return (payload as {
    choices?: readonly { message?: { content?: unknown } }[];
  })?.choices?.[0]?.message?.content;
}

/**
 * Reads an OpenAI-compatible SSE completion into one string. Used by the
 * structured intent parser, whose request asks for streaming but which must
 * still work against an upstream that answers with a single JSON body.
 */
async function readStructuredStream(response: Response): Promise<string> {
  if (!response.body) {
    throw new OrganizationIntentParseError('Model provider returned no response stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0 || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = (payload as {
        choices?: readonly { delta?: { content?: unknown } }[];
      })?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) output += delta;
      if (output.length > 24_000) {
        throw new OrganizationIntentParseError('Model provider exceeded the reply length limit.');
      }
    }
  }
  return output;
}

async function readBossStream(
  response: Response,
  onProgress: OrganizationIntentParserInput['onProgress'],
): Promise<string> {
  if (!response.body) throw new OrganizationIntentParseError('Boss model provider returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let sawDone = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0 || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) {
          throw new OrganizationIntentParseError('Boss model provider returned an invalid stream frame.');
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          sawDone = true;
          continue;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          throw new OrganizationIntentParseError('Boss model provider returned invalid stream JSON.');
        }
        const delta = (payload as {
          choices?: readonly { delta?: { content?: unknown } }[];
        })?.choices?.[0]?.delta?.content;
        if (typeof delta !== 'string' || delta.length === 0) continue;
        output += delta;
        if (output.length > 24_000) {
          throw new OrganizationIntentParseError('Boss model provider exceeded the reply length limit.');
        }
        onProgress?.({
          state: 'streaming',
          percent: Math.min(95, Math.max(5, Math.round(output.length / 2))),
          previousText: partialBossReply(output),
        });
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!sawDone || output.length === 0) {
    throw new OrganizationIntentParseError('Boss model provider returned an incomplete stream.');
  }
  onProgress?.({ state: 'streaming', percent: 100, previousText: '' });
  return output;
}

function partialBossReply(output: string): string {
  const match = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(output);
  if (!match?.[1]) return '';
  try {
    return JSON.parse(`"${match[1]}"`).slice(0, 4000);
  } catch {
    return match[1].replace(/\\n/g, ' ').slice(0, 4000);
  }
}
