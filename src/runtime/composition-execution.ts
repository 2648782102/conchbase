import {
  compositionDocumentId,
  parseCompositionDocument,
  type CompositionDocument,
  type CompositionDocumentId,
} from './composition-document.js';
import type { ConfigurationDocumentV2 } from './configuration-document.js';

export interface CompositionExecutionPlan {
  readonly compositionDocumentId: CompositionDocumentId;
  readonly nodeIds: readonly string[];
  readonly nodeCount: number;
  readonly terminalNodeIds: readonly string[];
}

export function compositionNodeOrder(composition: CompositionDocument): readonly string[] {
  const incomingCount = new Map<string, number>(
    composition.nodes.map((node) => [node.id, 0] as const),
  );
  const targets = new Map<string, string[]>(
    composition.nodes.map((node) => [node.id, [] as string[]] as const),
  );
  for (const link of composition.links) {
    incomingCount.set(link.to, (incomingCount.get(link.to) ?? 0) + 1);
    targets.get(link.from)?.push(link.to);
  }
  for (const nodeTargets of targets.values()) nodeTargets.sort();

  const ready = [...composition.entryNodeIds]
    .filter((nodeId) => incomingCount.get(nodeId) === 0)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const nodeId = ready.shift();
    if (nodeId === undefined) break;
    order.push(nodeId);
    for (const target of targets.get(nodeId) ?? []) {
      const remaining = (incomingCount.get(target) ?? 0) - 1;
      incomingCount.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
    ready.sort();
  }
  if (order.length !== composition.nodes.length) {
    throw new Error('Composition execution order is incomplete.');
  }
  return Object.freeze(order);
}

export function planCompositionExecution(
  document: ConfigurationDocumentV2,
): CompositionExecutionPlan {
  const composition = parseCompositionDocument(document.composition);
  return Object.freeze({
    compositionDocumentId: compositionDocumentId(composition),
    nodeIds: compositionNodeOrder(composition),
    nodeCount: composition.nodes.length,
    terminalNodeIds: composition.terminalNodeIds,
  });
}

export function compositionOutput(plan: CompositionExecutionPlan): string {
  return `composition:${plan.compositionDocumentId}:${plan.terminalNodeIds.join(',')}`;
}
