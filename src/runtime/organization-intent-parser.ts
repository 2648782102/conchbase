import { createHash } from 'node:crypto';
import {
  createOrganization,
  parseOrganizationAction,
  type OrganizationAction,
  type OrganizationSnapshot,
} from './organization-contract.js';
import { chineseAgentDisplayName } from './agent-name.js';

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
  const actions = rawActions.map((candidate, index) =>
    actionAt(parseOrganizationAction(candidate), baseSequence + index));
  const relay = value.relay === null || value.relay === undefined ? null : value.relay;
  if (relay !== null && (typeof relay !== 'string' || relay.length > 2000)) {
    throw new OrganizationIntentParseError('Structured adapter relay is not bounded.');
  }
  if (/sk-|Bearer|ghp_|github_pat_|password|apiKey|privateKey/i.test(relay ?? '')) {
    throw new OrganizationIntentParseError('Structured adapter relay contains secret-like content.');
  }
  return Object.freeze({
    version: ORGANIZATION_INTENT_PARSER_VERSION,
    intentId: input.intentId,
    actions: Object.freeze(actions),
    relay,
  });
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
      if (/sk-|Bearer|ghp_|github_pat_|password|apiKey|privateKey/i.test(text)) {
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
  'Always include numeric expectedSequence and string projectId. The Runtime replaces expectedSequence and model references before validation.',
  'For create_agent also include workerId, delegationId, agentRevisionId, displayName, instructionsDigest, scope, capabilities, model, maxDelegationDepth, ttlEvents.',
  'Never invent capabilities, secret values, file paths, URLs, or role enums.',
  'If the user text cannot be represented exactly by accepted actions, return {"actions":[],"relay":"No safe structured action."}.',
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
    Accept: 'application/json',
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
            stream: false,
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
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new OrganizationIntentParseError('Model provider returned invalid JSON.');
      }
      const content = (payload as {
        choices?: readonly { message?: { content?: unknown } }[];
      })?.choices?.[0]?.message?.content;
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
