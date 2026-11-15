import type { CapabilityGrant } from './agent-profile.js';
import type { ToolDefinition, ToolProvider } from './tool-provider.js';

export interface SkillGrantCandidate {
  readonly name: string;
  readonly instructions: string;
}

/**
 * Projects the Runtime-wide tool provider onto the capabilities pinned to one
 * Agent revision. Grants can only narrow: a name that the Runtime does not
 * register is inert, never an error. A projection with no granted tool returns
 * `undefined` so no empty tool block reaches the provider.
 */
export function projectToolProvider(
  provider: ToolProvider | undefined,
  grants: readonly CapabilityGrant[],
): ToolProvider | undefined {
  if (!provider) return undefined;
  const granted = new Set(grants.filter((grant) => grant.kind === 'tool').map((grant) => grant.name));
  if (granted.size === 0) return undefined;
  const definitions: readonly ToolDefinition[] = Object.freeze(
    provider.list().filter((tool) => granted.has(tool.id)),
  );
  if (definitions.length === 0) return undefined;
  const ids = new Set(definitions.map((tool) => tool.id));
  return Object.freeze({
    list: () => definitions,
    has: (toolId: string) => ids.has(toolId),
    invoke: (toolId: string, args: Parameters<ToolProvider['invoke']>[1]) => {
      if (!ids.has(toolId)) throw new Error('Tool is not granted to this Agent revision.');
      return provider.invoke(toolId, args);
    },
  });
}

export function projectSkills<T extends SkillGrantCandidate>(
  skills: readonly T[] | undefined,
  grants: readonly CapabilityGrant[],
): readonly T[] {
  if (!skills || skills.length === 0) return Object.freeze([]);
  const granted = new Set(grants.filter((grant) => grant.kind === 'skill').map((grant) => grant.name));
  if (granted.size === 0) return Object.freeze([]);
  return Object.freeze(skills.filter((skill) => granted.has(skill.name)));
}

const WORKER_BUILTIN_TOOLS = Object.freeze(['text_search', 'workspace_list', 'workspace_read'] as const);

/**
 * Conservative grant set for dynamically hired worker Agents: the Runtime's
 * read-only built-in tools plus whatever Skills the administrator loaded.
 * Writes, MCP, and plugin capabilities are never granted implicitly.
 */
export function defaultWorkerGrants(
  tools: ToolProvider | undefined,
  skills: readonly SkillGrantCandidate[] | undefined,
): readonly CapabilityGrant[] {
  const available = new Set(tools?.list().map((tool) => tool.id) ?? []);
  const toolGrants: CapabilityGrant[] = WORKER_BUILTIN_TOOLS
    .filter((name) => available.has(name))
    .map((name) => Object.freeze({ kind: 'tool' as const, name }));
  const skillGrants: CapabilityGrant[] = (skills ?? [])
    .map((skill) => Object.freeze({ kind: 'skill' as const, name: skill.name }));
  return Object.freeze([...toolGrants, ...skillGrants]);
}
