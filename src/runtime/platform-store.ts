import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlatformConflictError,
  PlatformNotFoundError,
  PLATFORM_CONTRACT_VERSION,
  opaquePlatformId,
  sha256Digest,
  tokenDigest,
  secretValueDigest,
  type AssignmentState,
  type AuthToken,
  type CapabilityRecord,
  type LocalSourceEvent,
  type OutboxState,
  type PairingSession,
  type PlatformWorkDetail,
  type ReceiptState,
  type SecretHandle,
  type SecretHandleUseReceipt,
  type WorkEventRecord,
  type WorkSnapshot,
  type WorkState,
} from './platform-contract.js';
import { type WorkItemDetail } from './work-contract.js';
import type { WorkStore } from './work-store.js';

export interface PlatformStore {
  createPairing(input: { label: string; challengeDigest: string }): PairingSession;
  listPairings(): readonly PairingSession[];
  approvePairing(input: { pairingId: string; challengeDigest: string }): PairingSession;
  revokePairing(pairingId: string): PairingSession;
  createToken(input: { pairingId: string; name: string; tokenDigest: string }): AuthToken;
  listTokens(): readonly AuthToken[];
  revokeToken(tokenId: string): AuthToken;
  isTokenActive(token: string): boolean;
  hasActiveToken(): boolean;
  ingestSourceEvent(event: Omit<LocalSourceEvent, 'version' | 'id'>): LocalSourceEvent;
  listSourceEvents(): readonly LocalSourceEvent[];
  putCapability(input: Omit<CapabilityRecord, 'version' | 'id' | 'createdAt'>): CapabilityRecord;
  listCapabilities(): readonly CapabilityRecord[];
  createSecretHandle(input: {
    key: string;
    value: string;
    purpose: string;
    allowedAdapter: string;
    destinationBinding: string;
  }): SecretHandle;
  listSecretHandles(): readonly SecretHandle[];
  rotateSecretHandle(handleId: string, value: string): SecretHandle;
  setSecretHandleStatus(handleId: string, status: 'active' | 'disabled'): SecretHandle;
  useSecretHandle(input: {
    handleId: string;
    workItemId: string;
    assignmentId: string;
    grantRevision: string;
  }): SecretHandleUseReceipt;
  listSecretHandleUseReceipts(): readonly SecretHandleUseReceipt[];
  listWorkItems(): readonly WorkSnapshot[];
  getWorkItemDetail(workItemId: string): PlatformWorkDetail;
  listWorkEvents(): readonly WorkEventRecord[];
  startWork(workItemId: string, expectedState: WorkState): WorkSnapshot;
  stopWork(workItemId: string, expectedState: WorkState): WorkSnapshot;
  completeWork(workItemId: string, expectedState: WorkState): WorkSnapshot;
  recoverAssignments(): readonly { assignmentId: string; workItemId: string; state: 'interrupted' }[];
  reconcileAssignment(input: { assignmentId: string; outcome: 'succeeded' | 'failed' }): WorkSnapshot;
  decideDeliveryReceipt(receiptId: string, decision: 'accepted' | 'rejected'): WorkSnapshot;
}

function timingSafeDigestEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function eventId(sequence: number): string {
  return `evt_${String(sequence).padStart(12, '0')}`;
}

export interface FixedAdapterInjection {
  readonly handleId: string;
  readonly adapterId: string;
  readonly destinationBinding: string;
  readonly workItemId: string;
  readonly assignmentId: string;
  readonly grantRevision: string;
  readonly value: string;
}

export interface FixedAdapter {
  readonly id: string;
  applyBoundValue(input: FixedAdapterInjection): 'injected' | 'denied';
}

const PROCESS_SEALED_VALUE_KEY = randomBytes(32);

class DeterministicFixedAdapter implements FixedAdapter {
  readonly id = 'local-bound-fixture';

  applyBoundValue(input: FixedAdapterInjection): 'injected' | 'denied' {
    return input.value.length > 0 && input.adapterId === this.id ? 'injected' : 'denied';
  }
}

function sealValue(value: string): { cipher: string; iv: string; tag: string; digest: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', PROCESS_SEALED_VALUE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Object.freeze({
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    digest: secretValueDigest(value),
  });
}

function openSealedValue(row: SecretHandleRow): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    PROCESS_SEALED_VALUE_KEY,
    Buffer.from(row.value_iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(row.value_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.value_cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export class SqlitePlatformStore implements PlatformStore {
  private readonly workStore: WorkStore;
  private inTransaction = false;

  constructor(
    private readonly database: DatabaseSync,
    workStore: WorkStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly adapter: FixedAdapter = new DeterministicFixedAdapter(),
  ) {
    this.workStore = workStore;
  }

  createPairing(input: { label: string; challengeDigest: string }): PairingSession {
    const createdAt = this.clock();
    const id = opaquePlatformId('pair', { label: input.label, challengeDigest: input.challengeDigest, createdAt });
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO platform_pairings (id, status, label, created_at, approved_at, challenge_digest)
        VALUES (?, 'pending', ?, ?, NULL, ?)
      `).run(id, input.label, createdAt, input.challengeDigest);
      this.appendEvent('pairing.created', { pairingId: id });
    });
    return this.pairing(id);
  }

  listPairings(): readonly PairingSession[] {
    return Object.freeze((this.database.prepare('SELECT * FROM platform_pairings ORDER BY created_at, id')
      .all() as unknown as PairingRow[]).map(toPairing));
  }

  approvePairing(input: { pairingId: string; challengeDigest: string }): PairingSession {
    const current = this.pairing(input.pairingId);
    if (!timingSafeDigestEqual(current.challengeDigest, input.challengeDigest)) {
      throw new PlatformConflictError('Pairing challenge does not match.');
    }
    if (current.status === 'revoked') throw new PlatformConflictError('Pairing was revoked.');
    this.transaction(() => {
      this.database.prepare('UPDATE platform_pairings SET status = ?, approved_at = ? WHERE id = ?')
        .run('approved', current.approvedAt ?? this.clock(), input.pairingId);
      this.appendEvent('pairing.approved', { pairingId: input.pairingId });
    });
    return this.pairing(input.pairingId);
  }

  revokePairing(pairingId: string): PairingSession {
    this.pairing(pairingId);
    return this.transaction(() => {
      this.database.prepare('UPDATE platform_pairings SET status = ? WHERE id = ?').run('revoked', pairingId);
      this.database.prepare('UPDATE platform_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE pairing_id = ?')
        .run(this.clock(), pairingId);
      this.appendEvent('pairing.revoked', { pairingId });
      return this.pairing(pairingId);
    });
  }

  createToken(input: { pairingId: string; name: string; tokenDigest: string }): AuthToken {
    const pairing = this.pairing(input.pairingId);
    if (pairing.status !== 'approved') throw new PlatformConflictError('Pairing is not approved.');
    const id = opaquePlatformId('tok', { ...input, createdAt: this.clock() });
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO platform_tokens (id, pairing_id, name, token_digest, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(id, input.pairingId, input.name, input.tokenDigest, this.clock());
      this.appendEvent('auth.token_created', { tokenId: id, pairingId: input.pairingId });
      return this.token(id);
    });
  }

  listTokens(): readonly AuthToken[] {
    return Object.freeze((this.database.prepare('SELECT * FROM platform_tokens ORDER BY created_at, id')
      .all() as unknown as TokenRow[]).map(toToken));
  }

  revokeToken(tokenId: string): AuthToken {
    this.token(tokenId);
    return this.transaction(() => {
      this.database.prepare('UPDATE platform_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
        .run(this.clock(), tokenId);
      this.appendEvent('auth.token_revoked', { tokenId });
      return this.token(tokenId);
    });
  }

  isTokenActive(token: string): boolean {
    const digest = tokenDigest(token);
    const row = this.database.prepare(`
      SELECT t.id FROM platform_tokens t
      JOIN platform_pairings p ON p.id = t.pairing_id
      WHERE t.token_digest = ? AND t.revoked_at IS NULL
        AND p.status = 'approved'
      LIMIT 1
    `).get(digest) as { id: string } | undefined;
    return row !== undefined;
  }

  hasActiveToken(): boolean {
    const row = this.database.prepare(`
      SELECT t.id FROM platform_tokens t
      JOIN platform_pairings p ON p.id = t.pairing_id
      WHERE t.revoked_at IS NULL AND p.status = 'approved'
      LIMIT 1
    `).get() as { id: string } | undefined;
    return row !== undefined;
  }

  ingestSourceEvent(event: Omit<LocalSourceEvent, 'version' | 'id'>): LocalSourceEvent {
    const id = opaquePlatformId('src', event);
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM platform_source_events WHERE id = ?')
        .get(id) as SourceEventRow | undefined;
      if (existing) return toSourceEvent(existing);
      this.database.prepare(`
        INSERT INTO platform_source_events (
          id, source_id, thread_key, payload_digest, occurred_at, policy, mandate_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, event.sourceId, event.threadKey, event.payloadDigest, event.occurredAt, event.policy, event.mandateDigest);
      this.appendEvent('source.event_observed', {
        sourceEventId: id,
        sourceId: event.sourceId,
        threadKey: event.threadKey,
        policy: event.policy,
      });
      if (event.policy === 'allow') {
        const item = this.workStore.listWorkItems().find((candidate) => {
          const detail = this.workStore.getWorkItemDetail(candidate.id);
          return detail.thread.threadKey === event.threadKey;
        });
        if (!item) throw new PlatformNotFoundError('WorkItem for Source event was not found.');
        if (item.state === 'open' || item.state === 'paused') this.startWork(item.id, item.state);
      }
      const stored = this.database.prepare('SELECT * FROM platform_source_events WHERE id = ?').get(id) as unknown as SourceEventRow;
      return toSourceEvent(stored);
    });
  }

  listSourceEvents(): readonly LocalSourceEvent[] {
    return Object.freeze((this.database.prepare('SELECT * FROM platform_source_events ORDER BY occurred_at, id')
      .all() as unknown as SourceEventRow[]).map(toSourceEvent));
  }

  putCapability(input: Omit<CapabilityRecord, 'version' | 'id' | 'createdAt'>): CapabilityRecord {
    const id = opaquePlatformId('cap', { kind: input.kind, name: input.name });
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT created_at FROM platform_capabilities WHERE id = ?')
        .get(id) as { created_at: string } | undefined;
      this.database.prepare(`
        INSERT INTO platform_capabilities (id, kind, name, status, descriptor, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, descriptor = excluded.descriptor
      `).run(id, input.kind, input.name, input.status, input.descriptor, existing?.created_at ?? this.clock());
      this.appendEvent('capability.configured', { capabilityId: id, kind: input.kind, status: input.status });
      return this.capability(id);
    });
  }

  listCapabilities(): readonly CapabilityRecord[] {
    return Object.freeze((this.database.prepare('SELECT * FROM platform_capabilities ORDER BY kind, name')
      .all() as unknown as CapabilityRow[]).map(toCapability));
  }

  createSecretHandle(input: {
    key: string;
    value: string;
    purpose: string;
    allowedAdapter: string;
    destinationBinding: string;
  }): SecretHandle {
    const existing = this.database.prepare('SELECT id FROM platform_secret_handles WHERE key = ?')
      .get(input.key) as { id: string } | undefined;
    if (existing) throw new PlatformConflictError('SecretHandle key already exists.');
    const id = opaquePlatformId('sh', { key: input.key });
    return this.transaction(() => {
      const sealed = sealValue(input.value);
      this.database.prepare(`
        INSERT INTO platform_secret_handles (
          id, key, secret_version, status, purpose, allowed_adapter, destination_binding,
          value_digest, value_cipher, value_iv, value_tag, created_at, rotated_at
        ) VALUES (?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        id, input.key, input.purpose, input.allowedAdapter, input.destinationBinding,
        sealed.digest, sealed.cipher, sealed.iv, sealed.tag, this.clock(),
      );
      this.appendEvent('secret.handle_configured', { handleId: id, secretVersion: 1 });
      return this.secretHandle(id);
    });
  }

  listSecretHandles(): readonly SecretHandle[] {
    return Object.freeze((this.database.prepare('SELECT * FROM platform_secret_handles ORDER BY key')
      .all() as unknown as SecretHandleRow[]).map(toSecretHandle));
  }

  rotateSecretHandle(handleId: string, value: string): SecretHandle {
    const current = this.secretHandle(handleId);
    const sealed = sealValue(value);
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE platform_secret_handles
        SET secret_version = ?, value_digest = ?, value_cipher = ?, value_iv = ?, value_tag = ?, rotated_at = ?
        WHERE id = ?
      `).run(
        current.secretVersion + 1, sealed.digest, sealed.cipher, sealed.iv, sealed.tag,
        this.clock(), handleId,
      );
      this.appendEvent('secret.handle_rotated', { handleId, secretVersion: current.secretVersion + 1 });
      return this.secretHandle(handleId);
    });
  }

  setSecretHandleStatus(handleId: string, status: 'active' | 'disabled'): SecretHandle {
    this.secretHandle(handleId);
    return this.transaction(() => {
      this.database.prepare('UPDATE platform_secret_handles SET status = ? WHERE id = ?').run(status, handleId);
      this.appendEvent('secret.handle_status_changed', { handleId, status });
      return this.secretHandle(handleId);
    });
  }

  useSecretHandle(input: {
    handleId: string;
    workItemId: string;
    assignmentId: string;
    grantRevision: string;
  }): SecretHandleUseReceipt {
    const handle = this.secretHandle(input.handleId);
    const row = this.database.prepare('SELECT * FROM platform_secret_handles WHERE id = ?')
      .get(handle.id) as unknown as SecretHandleRow;
    let outcome: 'injected' | 'denied' = 'denied';
    if (handle.status === 'active' && handle.allowedAdapter === this.adapter.id) {
      try {
        outcome = this.adapter.applyBoundValue({
          handleId: handle.id,
          adapterId: handle.allowedAdapter,
          destinationBinding: handle.destinationBinding,
          workItemId: input.workItemId,
          assignmentId: input.assignmentId,
          grantRevision: input.grantRevision,
          value: openSealedValue(row),
        });
      } catch {
        outcome = 'denied';
      }
    }
    const receiptCount = this.database.prepare('SELECT COUNT(*) AS count FROM platform_secret_use_receipts')
      .get() as { count: number };
    const id = opaquePlatformId('sur', {
      ...input,
      secretVersion: handle.secretVersion,
      outcome,
      receiptCount: receiptCount.count,
      createdAt: this.clock(),
    });
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO platform_secret_use_receipts (
          id, handle_id, secret_version_digest, grant_revision, adapter_id, destination_digest,
          outcome, work_item_id, assignment_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, handle.id, sha256Digest(handle.secretVersion), input.grantRevision, handle.allowedAdapter,
        sha256Digest(handle.destinationBinding), outcome, input.workItemId, input.assignmentId, this.clock(),
      );
      this.appendEvent('secret.handle_used', { handleId: handle.id, outcome, secretVersion: handle.secretVersion });
      return this.receipt(id);
    });
  }

  listSecretHandleUseReceipts(): readonly SecretHandleUseReceipt[] {
    return Object.freeze((this.database.prepare('SELECT * FROM platform_secret_use_receipts ORDER BY created_at, id')
      .all() as unknown as UseReceiptRow[]).map(toUseReceipt));
  }

  listWorkItems(): readonly WorkSnapshot[] {
    return Object.freeze(this.workStore.listWorkItems().map((item) => Object.freeze({
      version: PLATFORM_CONTRACT_VERSION,
      id: item.id,
      state: item.state,
      threadId: item.threadId,
      triggerId: item.triggerId,
      mandateId: item.mandateId,
      mandateRevision: 1,
    })));
  }

  getWorkItemDetail(workItemId: string): PlatformWorkDetail {
    const detail = this.workStore.getWorkItemDetail(workItemId);
    return this.toPlatformDetail(detail);
  }

  listWorkEvents(): readonly WorkEventRecord[] {
    const rows = this.database.prepare('SELECT * FROM work_events ORDER BY sequence')
      .all() as unknown as WorkEventRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      version: PLATFORM_CONTRACT_VERSION,
      id: row.id,
      sequence: row.sequence,
      type: row.type,
      workItemId: row.work_item_id || 'runtime',
      data: Object.freeze(JSON.parse(row.data) as Record<string, string | number | boolean>),
    })));
  }

  startWork(workItemId: string, expectedState: WorkState): WorkSnapshot {
    return this.transitionWork(workItemId, expectedState, 'running', ['open', 'paused'], 'work.started');
  }

  stopWork(workItemId: string, expectedState: WorkState): WorkSnapshot {
    return this.transitionWork(workItemId, expectedState, 'cancelled', ['running', 'paused'], 'work.stopped');
  }

  completeWork(workItemId: string, expectedState: WorkState): WorkSnapshot {
    const current = this.getWorkItemOrThrow(workItemId);
    if (current.state !== expectedState || current.state !== 'running') {
      throw new PlatformConflictError('WorkItem cannot be completed from its current state.');
    }
    return this.transaction(() => {
      this.database.prepare('UPDATE work_items SET state = ? WHERE id = ?').run('completed', workItemId);
      this.database.prepare("UPDATE work_assignments SET state = 'succeeded' WHERE work_item_id = ? AND state = 'running'")
        .run(workItemId);
      this.database.prepare("UPDATE work_outbox SET status = 'delivered' WHERE work_item_id = ? AND status IN ('pending','sent')")
        .run(workItemId);
      this.database.prepare("UPDATE work_delivery_receipts SET status = 'accepted' WHERE work_item_id = ? AND status = 'observed'")
        .run(workItemId);
      this.appendWorkEvent(workItemId, 'work.completed', { deliveryState: 'accepted' });
      return this.getWorkItemOrThrow(workItemId);
    });
  }

  recoverAssignments(): readonly { assignmentId: string; workItemId: string; state: 'interrupted' }[] {
    const rows = this.database.prepare(`
      SELECT id AS assignment_id, work_item_id FROM work_assignments WHERE state = 'interrupted'
    `).all() as unknown as { assignment_id: string; work_item_id: string }[];
    return Object.freeze(rows.map((row) => Object.freeze({
      assignmentId: row.assignment_id,
      workItemId: row.work_item_id,
      state: 'interrupted' as const,
    })));
  }

  reconcileAssignment(input: { assignmentId: string; outcome: 'succeeded' | 'failed' }): WorkSnapshot {
    const row = this.database.prepare('SELECT * FROM work_assignments WHERE id = ?')
      .get(input.assignmentId) as AssignmentRow | undefined;
    if (!row) throw new PlatformNotFoundError('Assignment not found.');
    if (row.state !== 'interrupted') throw new PlatformConflictError('Only interrupted assignments can be reconciled.');
    return this.transaction(() => {
      this.database.prepare('UPDATE work_assignments SET state = ? WHERE id = ?').run(input.outcome, input.assignmentId);
      const workState = input.outcome === 'succeeded' ? 'completed' : 'open';
      this.database.prepare('UPDATE work_items SET state = ? WHERE id = ?').run(workState, row.work_item_id);
      if (input.outcome === 'succeeded') {
        this.database.prepare("UPDATE work_outbox SET status = 'delivered' WHERE work_item_id = ? AND status IN ('pending','sent')")
          .run(row.work_item_id);
        this.database.prepare("UPDATE work_delivery_receipts SET status = 'accepted' WHERE work_item_id = ? AND status = 'observed'")
          .run(row.work_item_id);
      }
      this.appendWorkEvent(row.work_item_id, 'work.reconciled', { outcome: input.outcome });
      return this.getWorkItemOrThrow(row.work_item_id);
    });
  }

  decideDeliveryReceipt(receiptId: string, decision: 'accepted' | 'rejected'): WorkSnapshot {
    const row = this.database.prepare('SELECT * FROM work_delivery_receipts WHERE id = ?')
      .get(receiptId) as DeliveryReceiptRow | undefined;
    if (!row) throw new PlatformNotFoundError('DeliveryReceipt not found.');
    if (row.status !== 'observed') throw new PlatformConflictError('DeliveryReceipt already has a decision.');
    return this.transaction(() => {
      this.database.prepare('UPDATE work_delivery_receipts SET status = ? WHERE id = ?').run(decision, receiptId);
      this.appendWorkEvent(row.work_item_id, 'work.delivery_decided', { receiptId, decision });
      return this.getWorkItemOrThrow(row.work_item_id);
    });
  }

  private transitionWork(
    workItemId: string,
    expectedState: WorkState,
    nextState: WorkState,
    allowed: readonly WorkState[],
    eventType: string,
  ): WorkSnapshot {
    const current = this.getWorkItemOrThrow(workItemId);
    if (current.state !== expectedState || !allowed.includes(current.state)) {
      throw new PlatformConflictError('WorkItem cannot be transitioned from its current state.');
    }
    return this.transaction(() => {
      this.database.prepare('UPDATE work_items SET state = ? WHERE id = ?').run(nextState, workItemId);
      if (nextState === 'running') {
        this.database.prepare("UPDATE work_assignments SET state = 'running' WHERE work_item_id = ? AND state IN ('planned','interrupted')")
          .run(workItemId);
      } else if (nextState === 'cancelled') {
        this.database.prepare("UPDATE work_assignments SET state = 'cancelled' WHERE work_item_id = ? AND state IN ('planned','running')")
          .run(workItemId);
      }
      this.appendWorkEvent(workItemId, eventType, { state: nextState });
      return this.getWorkItemOrThrow(workItemId);
    });
  }

  private toPlatformDetail(detail: WorkItemDetail): PlatformWorkDetail {
    return Object.freeze({
      version: PLATFORM_CONTRACT_VERSION,
      workItem: Object.freeze({
        version: PLATFORM_CONTRACT_VERSION,
        id: detail.workItem.id,
        state: detail.workItem.state,
        threadId: detail.workItem.threadId,
        triggerId: detail.workItem.triggerId,
        mandateId: detail.workItem.mandateId,
        mandateRevision: 1,
      }),
      thread: Object.freeze({
        version: PLATFORM_CONTRACT_VERSION,
        id: detail.thread.id,
        threadKey: detail.thread.threadKey,
        contextOnly: true,
        triggerIds: detail.thread.triggerIds,
        workItemId: detail.thread.workItemId,
      }),
      mandate: Object.freeze({
        version: PLATFORM_CONTRACT_VERSION,
        id: detail.mandate.id,
        workItemId: detail.mandate.workItemId,
        revision: 1,
        scope: detail.mandate.scope,
        allowedOperations: detail.mandate.allowedOperations,
        capabilitiesDigest: detail.mandate.capabilitiesDigest,
      }),
      assignments: Object.freeze(detail.assignments.map((assignment) => Object.freeze({
        version: PLATFORM_CONTRACT_VERSION,
        id: assignment.id,
        workItemId: assignment.workItemId,
        state: assignment.state,
        agentRevisionId: assignment.agentRevisionId,
        configurationRevisionId: assignment.configurationRevisionId,
        mandateRevision: 1,
        model: Object.freeze({ ...assignment.model }),
      }))),
      outbox: Object.freeze(detail.outbox.map((record) => Object.freeze({
        version: PLATFORM_CONTRACT_VERSION,
        id: record.id,
        workItemId: record.workItemId,
        assignmentId: record.assignmentId,
        status: record.status,
        destinationDigest: record.destinationDigest,
        payloadDigest: record.payloadDigest,
      }))),
      deliveryReceipts: Object.freeze(detail.deliveryReceipts.map((receipt) => Object.freeze({
        version: PLATFORM_CONTRACT_VERSION,
        id: receipt.id,
        workItemId: receipt.workItemId,
        outboxId: receipt.outboxId,
        status: receipt.status,
        destinationDigest: receipt.destinationDigest,
        payloadDigest: receipt.payloadDigest,
      }))),
    });
  }

  private transaction<T>(action: () => T): T {
    if (this.inTransaction) return action();
    this.database.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = action();
      this.database.exec('COMMIT');
      this.inTransaction = false;
      return result;
    } catch (cause) {
      this.database.exec('ROLLBACK');
      this.inTransaction = false;
      throw cause;
    }
  }

  private pairing(id: string): PairingSession {
    const row = this.database.prepare('SELECT * FROM platform_pairings WHERE id = ?').get(id) as PairingRow | undefined;
    if (!row) throw new PlatformNotFoundError('Pairing session not found.');
    return toPairing(row);
  }
  private token(id: string): AuthToken {
    const row = this.database.prepare('SELECT * FROM platform_tokens WHERE id = ?').get(id) as TokenRow | undefined;
    if (!row) throw new PlatformNotFoundError('Token not found.');
    return toToken(row);
  }
  private capability(id: string): CapabilityRecord {
    const row = this.database.prepare('SELECT * FROM platform_capabilities WHERE id = ?').get(id) as CapabilityRow | undefined;
    if (!row) throw new PlatformNotFoundError('Capability record not found.');
    return toCapability(row);
  }
  private secretHandle(id: string): SecretHandle {
    const row = this.database.prepare('SELECT * FROM platform_secret_handles WHERE id = ?').get(id) as SecretHandleRow | undefined;
    if (!row) throw new PlatformNotFoundError('SecretHandle not found.');
    return toSecretHandle(row);
  }
  private receipt(id: string): SecretHandleUseReceipt {
    const row = this.database.prepare('SELECT * FROM platform_secret_use_receipts WHERE id = ?').get(id) as UseReceiptRow | undefined;
    if (!row) throw new PlatformNotFoundError('SecretHandle use receipt not found.');
    return toUseReceipt(row);
  }
  private getWorkItemOrThrow(id: string): WorkSnapshot {
    const item = this.listWorkItems().find((candidate) => candidate.id === id);
    if (!item) throw new PlatformNotFoundError('WorkItem not found.');
    return item;
  }
  private nextSequence(): number {
    const last = this.database.prepare('SELECT MAX(sequence) AS sequence FROM work_events')
      .get() as { sequence: number | null };
    return (last.sequence ?? 0) + 1;
  }
  private appendEvent(type: string, data: Record<string, string | number | boolean>): void {
    const sequence = this.nextSequence();
    this.database.prepare('INSERT INTO work_events (sequence, id, type, work_item_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(sequence, eventId(sequence), type, '', JSON.stringify(data));
  }
  private appendWorkEvent(workItemId: string, type: string, data: Record<string, string | number | boolean>): void {
    const sequence = this.nextSequence();
    this.database.prepare('INSERT INTO work_events (sequence, id, type, work_item_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(sequence, eventId(sequence), type, workItemId, JSON.stringify({ workItemId, ...data }));
  }
}

export function migratePlatformSchema(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version > 5) {
    throw new Error(`Database schema version ${version.user_version} is newer than this runtime supports.`);
  }
  if (version.user_version < 3) {
    database.exec(`
      CREATE TABLE work_items_v3 (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('open', 'running', 'paused', 'completed', 'cancelled')),
        thread_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        mandate_revision INTEGER NOT NULL CHECK (mandate_revision = 1)
      ) STRICT;
      INSERT INTO work_items_v3 (id, state, thread_id, trigger_id, mandate_id, mandate_revision)
        SELECT id, state, thread_id, trigger_id, mandate_id, mandate_revision FROM work_items;
      DROP TABLE work_items;
      ALTER TABLE work_items_v3 RENAME TO work_items;

      CREATE TABLE work_assignments_v3 (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'interrupted', 'succeeded', 'failed', 'cancelled')),
        agent_revision_id TEXT NOT NULL,
        configuration_revision_id TEXT NOT NULL,
        mandate_revision INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL
      ) STRICT;
      INSERT INTO work_assignments_v3 (
        id, work_item_id, state, agent_revision_id, configuration_revision_id,
        mandate_revision, provider_id, model_id
      ) SELECT id, work_item_id, state, agent_revision_id, configuration_revision_id,
        mandate_revision, provider_id, model_id FROM work_assignments;
      DROP TABLE work_assignments;
      ALTER TABLE work_assignments_v3 RENAME TO work_assignments;

      CREATE TABLE work_outbox_v3 (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
        destination_digest TEXT NOT NULL,
        payload_digest TEXT NOT NULL
      ) STRICT;
      INSERT INTO work_outbox_v3 (
        id, work_item_id, assignment_id, status, destination_digest, payload_digest
      ) SELECT id, work_item_id, assignment_id, status, destination_digest, payload_digest FROM work_outbox;
      DROP TABLE work_outbox;
      ALTER TABLE work_outbox_v3 RENAME TO work_outbox;

      CREATE TABLE work_delivery_receipts_v3 (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        outbox_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('observed', 'accepted', 'rejected')),
        destination_digest TEXT NOT NULL,
        payload_digest TEXT NOT NULL
      ) STRICT;
      INSERT INTO work_delivery_receipts_v3 (
        id, work_item_id, outbox_id, status, destination_digest, payload_digest
      ) SELECT id, work_item_id, outbox_id, status, destination_digest, payload_digest FROM work_delivery_receipts;
      DROP TABLE work_delivery_receipts;
      ALTER TABLE work_delivery_receipts_v3 RENAME TO work_delivery_receipts;
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_pairings (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')),
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      challenge_digest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_tokens (
      id TEXT PRIMARY KEY,
      pairing_id TEXT NOT NULL REFERENCES platform_pairings(id),
      name TEXT NOT NULL,
      token_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_source_events (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('allow', 'deny')),
      mandate_digest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_capabilities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('mcp', 'skill', 'plugin', 'secret-handle')),
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
      descriptor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(kind, name)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_secret_handles (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      secret_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      purpose TEXT NOT NULL,
      allowed_adapter TEXT NOT NULL,
      destination_binding TEXT NOT NULL,
      value_digest TEXT NOT NULL,
      value_cipher TEXT NOT NULL,
      value_iv TEXT NOT NULL,
      value_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_secret_use_receipts (
      id TEXT PRIMARY KEY,
      handle_id TEXT NOT NULL REFERENCES platform_secret_handles(id),
      secret_version_digest TEXT NOT NULL,
      grant_revision TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      destination_digest TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('injected', 'denied')),
      work_item_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  recoverRunningWork(database);
}

function recoverRunningWork(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT a.id AS assignment_id, a.work_item_id
    FROM work_assignments a JOIN work_items i ON i.id = a.work_item_id
    WHERE a.state = 'running' AND i.state = 'running'
  `).all() as unknown as { assignment_id: string; work_item_id: string }[];
  for (const row of rows) {
    database.prepare('UPDATE work_assignments SET state = ? WHERE id = ?')
      .run('interrupted', row.assignment_id);
    database.prepare('UPDATE work_items SET state = ? WHERE id = ?')
      .run('paused', row.work_item_id);
    appendRecoveredEvent(database, row.work_item_id, row.assignment_id);
  }
}

function appendRecoveredEvent(
  database: DatabaseSync,
  workItemId: string,
  assignmentId: string,
): void {
  const last = database.prepare('SELECT MAX(sequence) AS sequence FROM work_events')
    .get() as { sequence: number | null };
  const sequence = (last.sequence ?? 0) + 1;
  database.prepare('INSERT INTO work_events (sequence, id, type, work_item_id, data) VALUES (?, ?, ?, ?, ?)')
    .run(
      sequence,
      `evt_${String(sequence).padStart(12, '0')}`,
      'work.recovered',
      workItemId,
      JSON.stringify({ workItemId, assignmentId }),
    );
}

interface PairingRow {
  id: string; status: 'pending' | 'approved' | 'revoked'; label: string;
  created_at: string; approved_at: string | null; challenge_digest: string;
}
interface TokenRow {
  id: string; pairing_id: string; name: string; token_digest: string;
  created_at: string; revoked_at: string | null;
}
interface SourceEventRow {
  id: string; source_id: string; thread_key: string; payload_digest: string;
  occurred_at: string; policy: 'allow' | 'deny'; mandate_digest: string;
}
interface CapabilityRow {
  id: string; kind: 'mcp' | 'skill' | 'plugin' | 'secret-handle'; name: string;
  status: 'enabled' | 'disabled'; descriptor: string; created_at: string;
}
interface SecretHandleRow {
  id: string; key: string; secret_version: number; status: 'active' | 'disabled';
  purpose: string; allowed_adapter: string; destination_binding: string;
  value_digest: string; value_cipher: string; value_iv: string; value_tag: string;
  created_at: string; rotated_at: string | null;
}
interface UseReceiptRow {
  id: string; handle_id: string; secret_version_digest: string; grant_revision: string;
  adapter_id: string; destination_digest: string; outcome: 'injected' | 'denied';
  work_item_id: string; assignment_id: string; created_at: string;
}
interface AssignmentRow {
  id: string; work_item_id: string; state: AssignmentState; agent_revision_id: string;
  configuration_revision_id: string; mandate_revision: number; provider_id: string; model_id: string;
}
interface OutboxRow {
  id: string; work_item_id: string; assignment_id: string; status: OutboxState;
  destination_digest: string; payload_digest: string;
}
interface DeliveryReceiptRow {
  id: string; work_item_id: string; outbox_id: string; status: ReceiptState;
  destination_digest: string; payload_digest: string;
}
interface WorkEventRow {
  sequence: number; id: string; type: string; work_item_id: string; data: string;
}

function toPairing(row: PairingRow): PairingSession {
  return Object.freeze({
    version: PLATFORM_CONTRACT_VERSION, id: row.id, status: row.status, label: row.label,
    createdAt: row.created_at, approvedAt: row.approved_at, challengeDigest: row.challenge_digest,
  });
}
function toToken(row: TokenRow): AuthToken {
  return Object.freeze({
    version: PLATFORM_CONTRACT_VERSION, id: row.id, pairingId: row.pairing_id, name: row.name,
    tokenDigest: row.token_digest, createdAt: row.created_at, revokedAt: row.revoked_at,
  });
}
function toSourceEvent(row: SourceEventRow): LocalSourceEvent {
  return Object.freeze({
    version: PLATFORM_CONTRACT_VERSION, id: row.id, sourceId: row.source_id, threadKey: row.thread_key,
    payloadDigest: row.payload_digest, occurredAt: row.occurred_at, policy: row.policy,
    mandateDigest: row.mandate_digest,
  });
}
function toCapability(row: CapabilityRow): CapabilityRecord {
  return Object.freeze({
    version: PLATFORM_CONTRACT_VERSION, id: row.id, kind: row.kind, name: row.name,
    status: row.status, descriptor: row.descriptor, createdAt: row.created_at,
  });
}
function toSecretHandle(row: SecretHandleRow): SecretHandle {
  return Object.freeze({
    version: PLATFORM_CONTRACT_VERSION, id: row.id, key: row.key, secretVersion: row.secret_version,
    status: row.status, purpose: row.purpose, allowedAdapter: row.allowed_adapter,
    destinationBinding: row.destination_binding, valueDigest: row.value_digest,
    createdAt: row.created_at, rotatedAt: row.rotated_at,
  });
}
function toUseReceipt(row: UseReceiptRow): SecretHandleUseReceipt {
  return Object.freeze({
    version: PLATFORM_CONTRACT_VERSION, id: row.id, handleId: row.handle_id,
    secretVersionDigest: row.secret_version_digest, grantRevision: row.grant_revision,
    adapterId: row.adapter_id, destinationDigest: row.destination_digest, outcome: row.outcome,
    workItemId: row.work_item_id, assignmentId: row.assignment_id, createdAt: row.created_at,
  });
}
