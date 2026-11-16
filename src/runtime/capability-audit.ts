import type { CapabilityGrant } from './agent-profile.js';
import type { TaskStore } from './task-store.js';

/**
 * Read-only audit of capability grants.
 *
 * A grant is part of an immutable Agent revision, but whether it still maps to
 * a registered tool or Skill is a fact about the current Runtime. Clients used
 * to have to reconstruct that by joining Agent revisions with the capability
 * directory themselves, which risks a client inventing authorization semantics.
 * The Runtime owns both sides, so it answers the question once.
 */

export interface CapabilityGrantAuditEntry extends CapabilityGrant {
  readonly stillAvailable: boolean;
}

export interface AgentCapabilityAudit {
  readonly agentId: string;
  readonly currentRevisionId: string;
  readonly archived: boolean;
  readonly grants: readonly CapabilityGrantAuditEntry[];
}

export interface CapabilityAudit {
  readonly version: 1;
  readonly agents: readonly AgentCapabilityAudit[];
  /** Grants whose target is not registered in the current Runtime. */
  readonly staleGrants: readonly {
    readonly agentId: string;
    readonly revisionId: string;
    readonly kind: CapabilityGrant['kind'];
    readonly name: string;
  }[];
}

function unique<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(items)]);
}

/**
 * Builds the audit from the current Agent revisions and registered capabilities.
 *
 * Tool and Skill grants are inert when their target is absent — that rule is
 * existing Runtime behaviour. This projection only makes it visible; it never
 * changes what a task may invoke.
 */
export function auditCapabilityGrants(
  store: Pick<TaskStore, 'listAgents' | 'getAgent'>,
  availableTools: readonly string[],
  availableSkills: readonly string[],
): CapabilityAudit {
  const toolIds = new Set(availableTools);
  const skillIds = new Set(availableSkills);
  const agents: AgentCapabilityAudit[] = [];
  const staleGrants: {
    agentId: string;
    revisionId: string;
    kind: CapabilityGrant['kind'];
    name: string;
  }[] = [];

  for (const record of store.listAgents()) {
    const detail = store.getAgent(record.id);
    if (!detail) continue;
    // The current revision decides what future tasks use. Historical revisions
    // remain visible through the normal Agent revision endpoint.
    const revision = detail.revisions.find((item) => item.id === detail.currentRevisionId) ?? detail.current;
    const grants = unique(revision.grantedCapabilities.map((grant) => `${grant.kind}:${grant.name}`))
      .map((key) => {
        const separator = key.indexOf(':');
        const kind = key.slice(0, separator) as CapabilityGrant['kind'];
        const name = key.slice(separator + 1);
        return Object.freeze({
          kind,
          name,
          stillAvailable: kind === 'tool' ? toolIds.has(name) : skillIds.has(name),
        });
      });
    for (const grant of grants) {
      if (grant.stillAvailable) continue;
      staleGrants.push(Object.freeze({
        agentId: detail.id,
        revisionId: revision.id,
        kind: grant.kind,
        name: grant.name,
      }));
    }
    agents.push(Object.freeze({
      agentId: detail.id,
      currentRevisionId: detail.currentRevisionId,
      archived: detail.archived,
      grants: Object.freeze(grants),
    }));
  }

  return Object.freeze({
    version: 1 as const,
    agents: Object.freeze(agents),
    staleGrants: Object.freeze(staleGrants),
  });
}
