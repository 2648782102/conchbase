import { createHash } from 'node:crypto';

export const WORK_CONTRACT_VERSION = 1;

export type WorkSourceKind = 'manual' | 'fake';

export interface WorkSource {
  readonly sourceId: string;
  readonly kind: WorkSourceKind;
}

export interface WorkTriggerInput {
  readonly triggerId: string;
  readonly threadKey: string;
  readonly payloadDigest: string;
  readonly occurredAt: string;
}

export interface WorkMandateInput {
  readonly scope: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly capabilitiesDigest: string;
}

export interface WorkModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface WorkTriggerRequest {
  readonly source: WorkSource;
  readonly trigger: WorkTriggerInput;
  readonly mandate: WorkMandateInput;
  readonly model: WorkModelReference;
  readonly agentRevisionId: string;
  readonly configurationRevisionId: string;
}

export interface WorkTrigger {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly sourceEventId: string;
  readonly sourceId: string;
  readonly sourceKind: WorkSourceKind;
  readonly threadKey: string;
  readonly threadId: string;
  readonly payloadDigest: string;
  readonly occurredAt: string;
  readonly canonicalDigest: string;
  readonly proposalDigest: string;
}

export interface WorkThread {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly threadKey: string;
  readonly contextOnly: true;
  readonly triggerIds: readonly string[];
  readonly workItemId: string;
}

export interface WorkMandate {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly workItemId: string;
  readonly revision: 1;
  readonly scope: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly capabilitiesDigest: string;
}

export interface WorkItem {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly state: 'open';
  readonly threadId: string;
  readonly triggerId: string;
  readonly mandateId: string;
  readonly mandateRevision: 1;
}

export interface WorkAssignment {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly workItemId: string;
  readonly state: 'planned';
  readonly agentRevisionId: string;
  readonly configurationRevisionId: string;
  readonly mandateRevision: 1;
  readonly model: WorkModelReference;
}

export interface WorkOutboxRecord {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly workItemId: string;
  readonly assignmentId: string;
  readonly status: 'pending';
  readonly destinationDigest: string;
  readonly payloadDigest: string;
}

export interface WorkDeliveryReceipt {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly workItemId: string;
  readonly outboxId: string;
  readonly status: 'observed';
  readonly destinationDigest: string;
  readonly payloadDigest: string;
}

export type WorkEventType =
  | 'work.trigger_ingested'
  | 'work.item_created'
  | 'work.assignment_planned'
  | 'work.outbox_recorded'
  | 'work.delivery_observed';

export interface WorkEvent {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly id: string;
  readonly sequence: number;
  readonly type: WorkEventType;
  readonly workItemId: string;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkEnvelope {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly created: boolean;
  readonly workItemCreated: boolean;
  readonly contextOnly: boolean;
  readonly trigger: WorkTrigger;
  readonly thread: WorkThread;
  readonly mandate: WorkMandate;
  readonly workItem: WorkItem;
  readonly assignments: readonly WorkAssignment[];
  readonly outbox: readonly WorkOutboxRecord[];
  readonly deliveryReceipts: readonly WorkDeliveryReceipt[];
  readonly events: readonly WorkEvent[];
}

export interface WorkItemDetail {
  readonly version: typeof WORK_CONTRACT_VERSION;
  readonly workItem: WorkItem;
  readonly thread: WorkThread;
  readonly mandate: WorkMandate;
  readonly assignments: readonly WorkAssignment[];
  readonly outbox: readonly WorkOutboxRecord[];
  readonly deliveryReceipts: readonly WorkDeliveryReceipt[];
}

export interface DurableWorkPlan {
  readonly trigger: WorkTrigger;
  readonly threadKey: string;
  readonly threadId: string;
  readonly mandate: WorkMandate;
  readonly workItem: WorkItem;
  readonly assignments: readonly WorkAssignment[];
  readonly outbox: readonly WorkOutboxRecord[];
  readonly deliveryReceipts: readonly WorkDeliveryReceipt[];
}

export class WorkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkValidationError';
  }
}

export class WorkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkConflictError';
  }
}

export class WorkNotFoundError extends Error {
  constructor() {
    super('WorkItem not found.');
    this.name = 'WorkNotFoundError';
  }
}

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const forbiddenTopologyWords = /\b(?:router|worker|three-layer|layered|hierarchy)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) {
    throw new WorkValidationError(`${path} contains unknown field ${unexpected[0]}.`);
  }
}

function boundedString(value: unknown, path: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new WorkValidationError(`${path} must be a non-empty string of at most ${maxLength} characters.`);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('://')) {
    throw new WorkValidationError(`${path} must not contain a path or URL.`);
  }
  if (/secret|credential|token|apiKey|Authorization/i.test(value)) {
    throw new WorkValidationError(`${path} must not be secret-like.`);
  }
  return value;
}

function digest(value: unknown, path: string): string {
  const text = boundedString(value, path, 71);
  if (!digestPattern.test(text)) {
    throw new WorkValidationError(`${path} must be a sha256:<64 lowercase hex> digest.`);
  }
  return text;
}

function boundedStrings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new WorkValidationError(`${path} must contain between 1 and 8 strings.`);
  }
  const values = value.map((item, index) => boundedString(item, `${path}[${index}]`, 80));
  for (const item of values) {
    if (forbiddenTopologyWords.test(item)) {
      throw new WorkValidationError(`${path} must not encode a canonical topology.`);
    }
  }
  return Object.freeze([...new Set(values)]);
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function opaqueId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

export function parseWorkTriggerRequest(body: unknown): WorkTriggerRequest {
  if (!isRecord(body)) throw new WorkValidationError('Request body must be an object.');
  assertExactKeys(body, 'Request body', [
    'source',
    'trigger',
    'mandate',
    'model',
    'agentRevisionId',
    'configurationRevisionId',
  ]);
  const source = body.source;
  const trigger = body.trigger;
  const mandate = body.mandate;
  const model = body.model;
  if (!isRecord(source)) throw new WorkValidationError('source must be an object.');
  if (!isRecord(trigger)) throw new WorkValidationError('trigger must be an object.');
  if (!isRecord(mandate)) throw new WorkValidationError('mandate must be an object.');
  if (!isRecord(model)) throw new WorkValidationError('model must be an object.');
  assertExactKeys(source, 'source', ['sourceId', 'kind']);
  assertExactKeys(trigger, 'trigger', ['triggerId', 'threadKey', 'payloadDigest', 'occurredAt']);
  assertExactKeys(mandate, 'mandate', ['scope', 'allowedOperations', 'capabilitiesDigest']);
  assertExactKeys(model, 'model', ['providerId', 'modelId']);
  if (source.kind !== 'manual' && source.kind !== 'fake') {
    throw new WorkValidationError('source.kind must be manual or fake.');
  }
  if (typeof trigger.occurredAt !== 'string' || Number.isNaN(Date.parse(trigger.occurredAt))) {
    throw new WorkValidationError('trigger.occurredAt must be an ISO-8601 date.');
  }
  if (trigger.occurredAt.length > 40) {
    throw new WorkValidationError('trigger.occurredAt is too long.');
  }
  const parsed: WorkTriggerRequest = {
    source: {
      sourceId: boundedString(source.sourceId, 'source.sourceId', 80),
      kind: source.kind,
    },
    trigger: {
      triggerId: boundedString(trigger.triggerId, 'trigger.triggerId', 120),
      threadKey: boundedString(trigger.threadKey, 'trigger.threadKey', 120),
      payloadDigest: digest(trigger.payloadDigest, 'trigger.payloadDigest'),
      occurredAt: trigger.occurredAt,
    },
    mandate: {
      scope: boundedStrings(mandate.scope, 'mandate.scope'),
      allowedOperations: boundedStrings(mandate.allowedOperations, 'mandate.allowedOperations'),
      capabilitiesDigest: digest(mandate.capabilitiesDigest, 'mandate.capabilitiesDigest'),
    },
    model: {
      providerId: boundedString(model.providerId, 'model.providerId', 80),
      modelId: boundedString(model.modelId, 'model.modelId', 120),
    },
    agentRevisionId: boundedString(body.agentRevisionId, 'agentRevisionId', 120),
    configurationRevisionId: boundedString(body.configurationRevisionId, 'configurationRevisionId', 120),
  };
  const serialized = JSON.stringify(parsed);
  if (/secret|credential|token|apiKey|Authorization/i.test(serialized)) {
    throw new WorkValidationError('Work Trigger must not contain secret-like fields.');
  }
  if (forbiddenTopologyWords.test(serialized)) {
    throw new WorkValidationError('Work Trigger must not encode a canonical topology.');
  }
  return Object.freeze(parsed);
}

export function workCanonicalDigest(request: WorkTriggerRequest): string {
  return canonicalHash(request);
}

export function workProposalDigest(request: WorkTriggerRequest): string {
  return canonicalHash({
    mandate: request.mandate,
    model: request.model,
    agentRevisionId: request.agentRevisionId,
    configurationRevisionId: request.configurationRevisionId,
  });
}

export function planDurableWork(request: WorkTriggerRequest): DurableWorkPlan {
  const canonicalDigest = workCanonicalDigest(request);
  const proposalDigest = workProposalDigest(request);
  const threadId = opaqueId('thr', { threadKey: request.trigger.threadKey });
  const mandateId = opaqueId('man', { canonicalDigest, scope: 'mandate' });
  const workItemId = opaqueId('work', { threadId });
  const triggerId = opaqueId('trg', {
    sourceEventId: request.trigger.triggerId,
    sourceId: request.source.sourceId,
    canonicalDigest,
  });
  const assignmentId = opaqueId('asg', { workItemId, canonicalDigest });
  const outboxId = opaqueId('obx', { assignmentId });
  const deliveryReceiptId = opaqueId('dlv', { outboxId });
  const destinationDigest = canonicalHash({
    destination: 'local-fixture',
    sourceId: request.source.sourceId,
    threadId,
  });
  const payloadDigest = request.trigger.payloadDigest;
  return Object.freeze({
    trigger: Object.freeze({
      version: WORK_CONTRACT_VERSION,
      id: triggerId,
      sourceEventId: request.trigger.triggerId,
      sourceId: request.source.sourceId,
      sourceKind: request.source.kind,
      threadKey: request.trigger.threadKey,
      threadId,
      payloadDigest,
      occurredAt: request.trigger.occurredAt,
      canonicalDigest,
      proposalDigest,
    }),
    threadKey: request.trigger.threadKey,
    threadId,
    mandate: Object.freeze({
      version: WORK_CONTRACT_VERSION,
      id: mandateId,
      workItemId,
      revision: 1,
      scope: request.mandate.scope,
      allowedOperations: request.mandate.allowedOperations,
      capabilitiesDigest: request.mandate.capabilitiesDigest,
    }),
    workItem: Object.freeze({
      version: WORK_CONTRACT_VERSION,
      id: workItemId,
      state: 'open',
      threadId,
      triggerId,
      mandateId,
      mandateRevision: 1,
    }),
    assignments: Object.freeze([Object.freeze({
      version: WORK_CONTRACT_VERSION,
      id: assignmentId,
      workItemId,
      state: 'planned',
      agentRevisionId: request.agentRevisionId,
      configurationRevisionId: request.configurationRevisionId,
      mandateRevision: 1,
      model: Object.freeze({ ...request.model }),
    })]),
    outbox: Object.freeze([Object.freeze({
      version: WORK_CONTRACT_VERSION,
      id: outboxId,
      workItemId,
      assignmentId,
      status: 'pending',
      destinationDigest,
      payloadDigest,
    })]),
    deliveryReceipts: Object.freeze([Object.freeze({
      version: WORK_CONTRACT_VERSION,
      id: deliveryReceiptId,
      workItemId,
      outboxId,
      status: 'observed',
      destinationDigest,
      payloadDigest,
    })]),
  });
}

export const WORK_EVENT_TYPES: readonly WorkEventType[] = Object.freeze([
  'work.trigger_ingested',
  'work.item_created',
  'work.assignment_planned',
  'work.outbox_recorded',
  'work.delivery_observed',
]);
