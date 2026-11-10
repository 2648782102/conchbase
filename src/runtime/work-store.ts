import {
  WORK_EVENT_TYPES,
  WorkConflictError,
  WorkNotFoundError,
  planDurableWork,
  workProposalDigest,
  type DurableWorkPlan,
  type WorkDeliveryReceipt,
  type WorkEnvelope,
  type WorkEvent,
  type WorkEventType,
  type WorkItem,
  type WorkItemDetail,
  type WorkThread,
  type WorkTrigger,
  type WorkTriggerRequest,
} from './work-contract.js';
import type { DatabaseSync } from 'node:sqlite';

export interface WorkStore {
  ingestWorkTrigger(request: WorkTriggerRequest): WorkEnvelope;
  listWorkItems(): readonly WorkItem[];
  getWorkItemDetail(workItemId: string): WorkItemDetail;
  listDeliveryReceipts(): readonly WorkDeliveryReceipt[];
}

export class InMemoryWorkStore implements WorkStore {
  private readonly triggers = new Map<string, WorkTrigger>();
  private readonly threads = new Map<string, WorkThread>();
  private readonly plans = new Map<string, DurableWorkPlan>();
  private readonly events: WorkEvent[] = [];

  ingestWorkTrigger(request: WorkTriggerRequest): WorkEnvelope {
    const plan = planDurableWork(request);
    const existingTrigger = this.triggers.get(plan.trigger.sourceEventId);
    if (existingTrigger) {
      if (existingTrigger.canonicalDigest !== plan.trigger.canonicalDigest) {
        throw new WorkConflictError('Trigger id was already ingested with different content.');
      }
      return this.envelope(existingTrigger, false, false, false);
    }
    const existingThread = this.threads.get(plan.threadKey);
    if (existingThread) {
      const existingPlan = this.plans.get(existingThread.workItemId);
        if (!existingPlan || existingPlan.trigger.proposalDigest !== plan.trigger.proposalDigest) {
        throw new WorkConflictError('A Thread context event cannot change its Mandate or Assignment.');
      }
      const contextThread: WorkThread = Object.freeze({
        ...existingThread,
        triggerIds: Object.freeze([...existingThread.triggerIds, plan.trigger.id]),
      });
      this.threads.set(plan.threadKey, contextThread);
      this.triggers.set(plan.trigger.sourceEventId, plan.trigger);
      this.addEvents(plan, ['work.trigger_ingested'], contextThread.triggerIds.length);
      return this.envelope(plan.trigger, true, false, true, contextThread);
    }

    const thread: WorkThread = Object.freeze({
      version: 1,
      id: plan.threadId,
      threadKey: plan.threadKey,
      contextOnly: true,
      triggerIds: Object.freeze([plan.trigger.id]),
      workItemId: plan.workItem.id,
    });
    this.threads.set(plan.threadKey, thread);
    this.plans.set(plan.workItem.id, plan);
    this.triggers.set(plan.trigger.sourceEventId, plan.trigger);
    this.addEvents(plan, WORK_EVENT_TYPES, 1);
    return this.envelope(plan.trigger, true, true, false, thread);
  }

  listWorkItems(): readonly WorkItem[] {
    return Object.freeze([...this.plans.values()].map((plan) => plan.workItem));
  }

  getWorkItemDetail(workItemId: string): WorkItemDetail {
    const plan = this.plans.get(workItemId);
    if (!plan) throw new WorkNotFoundError();
    const thread = [...this.threads.values()].find((item) => item.id === plan.threadId);
    if (!thread) throw new WorkNotFoundError();
    return Object.freeze({
      version: 1,
      workItem: plan.workItem,
      thread,
      mandate: plan.mandate,
      assignments: plan.assignments,
      outbox: plan.outbox,
      deliveryReceipts: plan.deliveryReceipts,
    });
  }

  listDeliveryReceipts(): readonly WorkDeliveryReceipt[] {
    return Object.freeze([...this.plans.values()].flatMap((plan) => [...plan.deliveryReceipts]));
  }

  private addEvents(
    plan: DurableWorkPlan,
    types: readonly WorkEventType[],
    triggerCount: number,
  ): void {
    for (const type of types) {
      const sequence = this.events.length + 1;
      const data: Record<string, string | number | boolean> = {
        triggerId: plan.trigger.id,
        threadId: plan.threadId,
        workItemId: plan.workItem.id,
        triggerCount,
      };
      if (type === 'work.item_created') data.mandateId = plan.mandate.id;
      if (type === 'work.assignment_planned') data.assignmentId = plan.assignments[0]!.id;
      if (type === 'work.outbox_recorded') data.outboxId = plan.outbox[0]!.id;
      if (type === 'work.delivery_observed') data.deliveryReceiptId = plan.deliveryReceipts[0]!.id;
      this.events.push(Object.freeze({
        version: 1,
        id: `evt_${String(sequence).padStart(12, '0')}`,
        sequence,
        type,
        workItemId: plan.workItem.id,
        data: Object.freeze(data),
      }));
    }
  }

  private envelope(
    trigger: WorkTrigger,
    created: boolean,
    workItemCreated: boolean,
    contextOnly: boolean,
    explicitThread?: WorkThread,
  ): WorkEnvelope {
    const thread = explicitThread ?? [...this.threads.values()]
      .find((item) => item.id === trigger.threadId);
    const plan = thread ? this.plans.get(thread.workItemId) : undefined;
    if (!thread || !plan) throw new WorkNotFoundError();
    const events = this.events.filter((event) => event.workItemId === plan.workItem.id);
    return Object.freeze({
      version: 1,
      created,
      workItemCreated,
      contextOnly,
      trigger,
      thread,
      mandate: plan.mandate,
      workItem: plan.workItem,
      assignments: plan.assignments,
      outbox: plan.outbox,
      deliveryReceipts: plan.deliveryReceipts,
      events: Object.freeze([...events]),
    });
  }
}

export class SqliteWorkStore implements WorkStore {
  constructor(private readonly database: DatabaseSync) {}

  ingestWorkTrigger(request: WorkTriggerRequest): WorkEnvelope {
    const plan = planDurableWork(request);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existingTrigger = this.database.prepare(
        'SELECT * FROM work_triggers WHERE source_event_id = ?',
      ).get(plan.trigger.sourceEventId) as WorkTriggerRow | undefined;
      if (existingTrigger) {
        if (existingTrigger.canonical_digest !== plan.trigger.canonicalDigest) {
          throw new WorkConflictError('Trigger id was already ingested with different content.');
        }
        this.database.exec('COMMIT');
        return this.envelope(plan.trigger.sourceEventId, false, false, false);
      }

      const existingThread = this.database.prepare(
        'SELECT * FROM work_threads WHERE thread_key = ?',
      ).get(plan.threadKey) as WorkThreadRow | undefined;
      if (existingThread) {
        const existingProposal = this.database.prepare(
          'SELECT proposal_digest FROM work_triggers WHERE id = ?',
        ).get(JSON.parse(existingThread.trigger_ids)[0]) as { proposal_digest: string } | undefined;
        if (!existingProposal || existingProposal.proposal_digest !== workProposalDigest(request)) {
          throw new WorkConflictError('A Thread context event cannot change its Mandate or Assignment.');
        }
        const triggerIds = [...JSON.parse(existingThread.trigger_ids) as string[], plan.trigger.id];
        this.database.prepare('UPDATE work_threads SET trigger_ids = ? WHERE thread_key = ?')
          .run(JSON.stringify(triggerIds), plan.threadKey);
        this.insertTrigger(plan);
        this.insertEvents(plan, ['work.trigger_ingested'], triggerIds.length);
        this.database.exec('COMMIT');
        return this.envelope(plan.trigger.sourceEventId, true, false, true);
      }

      this.database.prepare(`
        INSERT INTO work_threads (id, thread_key, context_only, trigger_ids, work_item_id)
        VALUES (?, ?, 1, ?, ?)
      `).run(plan.threadId, plan.threadKey, JSON.stringify([plan.trigger.id]), plan.workItem.id);
      this.insertTrigger(plan);
      this.database.prepare(`
        INSERT INTO work_mandates (
          id, work_item_id, revision, scope, allowed_operations, capabilities_digest
        ) VALUES (?, ?, 1, ?, ?, ?)
      `).run(
        plan.mandate.id,
        plan.mandate.workItemId,
        JSON.stringify(plan.mandate.scope),
        JSON.stringify(plan.mandate.allowedOperations),
        plan.mandate.capabilitiesDigest,
      );
      this.database.prepare(`
        INSERT INTO work_items (
          id, state, thread_id, trigger_id, mandate_id, mandate_revision
        ) VALUES (?, 'open', ?, ?, ?, 1)
      `).run(plan.workItem.id, plan.threadId, plan.trigger.id, plan.mandate.id);
      for (const assignment of plan.assignments) {
        this.database.prepare(`
          INSERT INTO work_assignments (
            id, work_item_id, state, agent_revision_id, configuration_revision_id,
            mandate_revision, provider_id, model_id
          ) VALUES (?, ?, 'planned', ?, ?, 1, ?, ?)
        `).run(
          assignment.id,
          assignment.workItemId,
          assignment.agentRevisionId,
          assignment.configurationRevisionId,
          assignment.model.providerId,
          assignment.model.modelId,
        );
      }
      for (const outbox of plan.outbox) {
        this.database.prepare(`
          INSERT INTO work_outbox (
            id, work_item_id, assignment_id, status, destination_digest, payload_digest
          ) VALUES (?, ?, ?, 'pending', ?, ?)
        `).run(
          outbox.id,
          outbox.workItemId,
          outbox.assignmentId,
          outbox.destinationDigest,
          outbox.payloadDigest,
        );
      }
      for (const receipt of plan.deliveryReceipts) {
        this.database.prepare(`
          INSERT INTO work_delivery_receipts (
            id, work_item_id, outbox_id, status, destination_digest, payload_digest
          ) VALUES (?, ?, ?, 'observed', ?, ?)
        `).run(
          receipt.id,
          receipt.workItemId,
          receipt.outboxId,
          receipt.destinationDigest,
          receipt.payloadDigest,
        );
      }
      this.insertEvents(plan, WORK_EVENT_TYPES, 1);
      this.database.exec('COMMIT');
      return this.envelope(plan.trigger.sourceEventId, true, true, false);
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
  }

  listWorkItems(): readonly WorkItem[] {
    const rows = this.database.prepare('SELECT * FROM work_items ORDER BY id').all() as unknown as WorkItemRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      version: 1,
      id: row.id,
      state: 'open',
      threadId: row.thread_id,
      triggerId: row.trigger_id,
      mandateId: row.mandate_id,
      mandateRevision: 1,
    })));
  }

  getWorkItemDetail(workItemId: string): WorkItemDetail {
    const item = this.listWorkItems().find((candidate) => candidate.id === workItemId);
    const threadRow = this.database.prepare('SELECT * FROM work_threads WHERE id = ?')
      .get(item?.threadId ?? '') as WorkThreadRow | undefined;
    const mandateRow = this.database.prepare('SELECT * FROM work_mandates WHERE work_item_id = ?')
      .get(workItemId) as WorkMandateRow | undefined;
    if (!item || !threadRow || !mandateRow) throw new WorkNotFoundError();
    const assignments = (this.database.prepare(
      'SELECT * FROM work_assignments WHERE work_item_id = ? ORDER BY id',
    ).all(workItemId) as unknown as WorkAssignmentRow[]).map(toAssignment);
    const outbox = (this.database.prepare(
      'SELECT * FROM work_outbox WHERE work_item_id = ? ORDER BY id',
    ).all(workItemId) as unknown as WorkOutboxRow[]).map(toOutbox);
    const deliveryReceipts = (this.database.prepare(
      'SELECT * FROM work_delivery_receipts WHERE work_item_id = ? ORDER BY id',
    ).all(workItemId) as unknown as WorkDeliveryReceiptRow[]).map(toDeliveryReceipt);
    return Object.freeze({
      version: 1,
      workItem: item,
      thread: Object.freeze({
        version: 1,
        id: threadRow.id,
        threadKey: threadRow.thread_key,
        contextOnly: true,
        triggerIds: Object.freeze(JSON.parse(threadRow.trigger_ids) as string[]),
        workItemId: threadRow.work_item_id,
      }),
      mandate: Object.freeze({
        version: 1,
        id: mandateRow.id,
        workItemId: mandateRow.work_item_id,
        revision: 1,
        scope: Object.freeze(JSON.parse(mandateRow.scope) as string[]),
        allowedOperations: Object.freeze(JSON.parse(mandateRow.allowed_operations) as string[]),
        capabilitiesDigest: mandateRow.capabilities_digest,
      }),
      assignments: Object.freeze(assignments),
      outbox: Object.freeze(outbox),
      deliveryReceipts: Object.freeze(deliveryReceipts),
    });
  }

  listDeliveryReceipts(): readonly WorkDeliveryReceipt[] {
    const rows = this.database.prepare(
      'SELECT * FROM work_delivery_receipts ORDER BY id',
    ).all() as unknown as WorkDeliveryReceiptRow[];
    return Object.freeze(rows.map(toDeliveryReceipt));
  }

  private insertTrigger(plan: DurableWorkPlan): void {
    this.database.prepare(`
      INSERT INTO work_triggers (
        id, source_event_id, source_id, source_kind, thread_key, thread_id,
        payload_digest, occurred_at, canonical_digest, proposal_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.trigger.id,
      plan.trigger.sourceEventId,
      plan.trigger.sourceId,
      plan.trigger.sourceKind,
      plan.trigger.threadKey,
      plan.trigger.threadId,
      plan.trigger.payloadDigest,
      plan.trigger.occurredAt,
      plan.trigger.canonicalDigest,
      plan.trigger.proposalDigest,
    );
  }

  private insertEvents(
    plan: DurableWorkPlan,
    types: readonly WorkEventType[],
    triggerCount: number,
  ): void {
    for (const type of types) {
      const last = this.database.prepare('SELECT MAX(sequence) AS sequence FROM work_events')
        .get() as { sequence: number | null };
      const sequence = (last.sequence ?? 0) + 1;
      const data: Record<string, string | number | boolean> = {
        triggerId: plan.trigger.id,
        threadId: plan.threadId,
        workItemId: plan.workItem.id,
        triggerCount,
      };
      if (type === 'work.item_created') data.mandateId = plan.mandate.id;
      if (type === 'work.assignment_planned') data.assignmentId = plan.assignments[0]!.id;
      if (type === 'work.outbox_recorded') data.outboxId = plan.outbox[0]!.id;
      if (type === 'work.delivery_observed') data.deliveryReceiptId = plan.deliveryReceipts[0]!.id;
      this.database.prepare(`
        INSERT INTO work_events (sequence, id, type, work_item_id, data)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        sequence,
        `evt_${String(sequence).padStart(12, '0')}`,
        type,
        plan.workItem.id,
        JSON.stringify(data),
      );
    }
  }

  private envelope(
    sourceEventId: string,
    created: boolean,
    workItemCreated: boolean,
    contextOnly: boolean,
  ): WorkEnvelope {
    const triggerRow = this.database.prepare(
      'SELECT * FROM work_triggers WHERE source_event_id = ?',
    ).get(sourceEventId) as WorkTriggerRow | undefined;
    if (!triggerRow) throw new WorkNotFoundError();
    const detail = this.getWorkItemDetail(this.workItemIdForThread(triggerRow.thread_id));
    const trigger: WorkTrigger = Object.freeze({
      version: 1,
      id: triggerRow.id,
      sourceEventId: triggerRow.source_event_id,
      sourceId: triggerRow.source_id,
      sourceKind: triggerRow.source_kind as 'manual' | 'fake',
      threadKey: triggerRow.thread_key,
      threadId: triggerRow.thread_id,
      payloadDigest: triggerRow.payload_digest,
      occurredAt: triggerRow.occurred_at,
      canonicalDigest: triggerRow.canonical_digest,
      proposalDigest: triggerRow.proposal_digest,
    });
    const events = (this.database.prepare(
      'SELECT * FROM work_events WHERE work_item_id = ? ORDER BY sequence',
    ).all(detail.workItem.id) as unknown as WorkEventRow[]).map((row) => Object.freeze({
      version: 1,
      id: row.id,
      sequence: row.sequence,
      type: row.type as WorkEventType,
      workItemId: row.work_item_id,
      data: Object.freeze(JSON.parse(row.data) as Record<string, string | number | boolean>),
    }));
    return Object.freeze({
      version: 1,
      created,
      workItemCreated,
      contextOnly,
      trigger,
      thread: detail.thread,
      mandate: detail.mandate,
      workItem: detail.workItem,
      assignments: detail.assignments,
      outbox: detail.outbox,
      deliveryReceipts: detail.deliveryReceipts,
      events: Object.freeze(events),
    });
  }

  private workItemIdForThread(threadId: string): string {
    const row = this.database.prepare('SELECT work_item_id FROM work_threads WHERE id = ?')
      .get(threadId) as { work_item_id: string } | undefined;
    if (!row) throw new WorkNotFoundError();
    return row.work_item_id;
  }
}

interface WorkTriggerRow {
  readonly id: string;
  readonly source_event_id: string;
  readonly source_id: string;
  readonly source_kind: string;
  readonly thread_key: string;
  readonly thread_id: string;
  readonly payload_digest: string;
  readonly occurred_at: string;
  readonly canonical_digest: string;
  readonly proposal_digest: string;
}

interface WorkThreadRow {
  readonly id: string;
  readonly thread_key: string;
  readonly context_only: number;
  readonly trigger_ids: string;
  readonly work_item_id: string;
}

interface WorkMandateRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly revision: number;
  readonly scope: string;
  readonly allowed_operations: string;
  readonly capabilities_digest: string;
}

interface WorkItemRow {
  readonly id: string;
  readonly state: string;
  readonly thread_id: string;
  readonly trigger_id: string;
  readonly mandate_id: string;
  readonly mandate_revision: number;
}

interface WorkAssignmentRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly state: string;
  readonly agent_revision_id: string;
  readonly configuration_revision_id: string;
  readonly mandate_revision: number;
  readonly provider_id: string;
  readonly model_id: string;
}

interface WorkOutboxRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly assignment_id: string;
  readonly status: string;
  readonly destination_digest: string;
  readonly payload_digest: string;
}

interface WorkDeliveryReceiptRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly outbox_id: string;
  readonly status: string;
  readonly destination_digest: string;
  readonly payload_digest: string;
}

interface WorkEventRow {
  readonly sequence: number;
  readonly id: string;
  readonly type: string;
  readonly work_item_id: string;
  readonly data: string;
}

function toAssignment(row: WorkAssignmentRow) {
  return Object.freeze({
    version: 1,
    id: row.id,
    workItemId: row.work_item_id,
    state: 'planned',
    agentRevisionId: row.agent_revision_id,
    configurationRevisionId: row.configuration_revision_id,
    mandateRevision: 1,
    model: Object.freeze({ providerId: row.provider_id, modelId: row.model_id }),
  });
}

function toOutbox(row: WorkOutboxRow) {
  return Object.freeze({
    version: 1,
    id: row.id,
    workItemId: row.work_item_id,
    assignmentId: row.assignment_id,
    status: 'pending',
    destinationDigest: row.destination_digest,
    payloadDigest: row.payload_digest,
  });
}

function toDeliveryReceipt(row: WorkDeliveryReceiptRow) {
  return Object.freeze({
    version: 1,
    id: row.id,
    workItemId: row.work_item_id,
    outboxId: row.outbox_id,
    status: 'observed',
    destinationDigest: row.destination_digest,
    payloadDigest: row.payload_digest,
  });
}
