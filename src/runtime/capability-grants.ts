import type { CapabilityGrant } from './agent-profile.js';
import type { ToolDefinition, ToolProvider } from './tool-provider.js';
import { scopeToolSet } from '../kernel/policy.js';

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
  // The narrowing rule lives in the kernel; this only applies its answer to a
  // provider. Keeping the rule here as well is what let scope and approval
  // drift apart in the first place.
  const registered = provider.list().map((tool) => tool.id);
  const { allowed } = scopeToolSet({ tools: registered }, grants);
  if (allowed.length === 0) return undefined;
  const granted = new Set(allowed);
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
  // Same rule, same kernel call: a skill grant can only narrow the registered
  // skills, and a tool grant with a matching name must not authorize one.
  const { skills: allowed } = scopeToolSet(
    { tools: [], skills: skills.map((skill) => skill.name) },
    grants,
  );
  if (allowed.length === 0) return Object.freeze([]);
  const granted = new Set(allowed);
  return Object.freeze(skills.filter((skill) => granted.has(skill.name)));
}

const WORKER_BUILTIN_TOOLS = Object.freeze(['text_search', 'workspace_list', 'workspace_read'] as const);
const WORKER_WRITE_TOOLS = Object.freeze(['workspace_write'] as const);
const WORKER_EXTERNAL_READ_TOOLS = Object.freeze(['web_extract', 'http_fetch'] as const);

/**
 * Conservative grant set for dynamically hired worker Agents: the Runtime's
 * read-only built-in tools plus whatever Skills the administrator loaded.
 * Writes, MCP, and plugin capabilities are never granted implicitly.
 */
export function defaultWorkerGrants(
  tools: ToolProvider | undefined,
  skills: readonly SkillGrantCandidate[] | undefined,
  options: { readonly allowWrites?: boolean } = {},
): readonly CapabilityGrant[] {
  const available = new Set(tools?.list().map((tool) => tool.id) ?? []);
  const candidates = options.allowWrites
    ? [...WORKER_BUILTIN_TOOLS, ...WORKER_EXTERNAL_READ_TOOLS, ...WORKER_WRITE_TOOLS]
    : [...WORKER_BUILTIN_TOOLS, ...WORKER_EXTERNAL_READ_TOOLS];
  const toolGrants: CapabilityGrant[] = candidates
    .filter((name) => available.has(name))
    .map((name) => Object.freeze({ kind: 'tool' as const, name }));
  const skillGrants: CapabilityGrant[] = (skills ?? [])
    .map((skill) => Object.freeze({ kind: 'skill' as const, name: skill.name }));
  return Object.freeze([...toolGrants, ...skillGrants]);
}

/**
 * User-facing capability presets.
 *
 * The names are what a person sees when choosing what an Agent may do; the
 * mapping to concrete grants stays here so the UI never invents capability.
 */
export type CapabilityPresetId = 'read-only' | 'workspace-editing' | 'local-commands' | 'external-integrations';

export interface CapabilityPreset {
  readonly id: CapabilityPresetId;
  readonly label: string;
  readonly description: string;
  readonly allowsWrites: boolean;
  readonly tools: readonly string[];
}

export const CAPABILITY_PRESETS: readonly CapabilityPreset[] = Object.freeze([
  Object.freeze({
    id: 'read-only',
    label: '只读',
    description: '查看工作区文件与搜索；不能修改任何内容。',
    allowsWrites: false,
    tools: Object.freeze(['workspace_list', 'workspace_read', 'text_search']),
  }),
  Object.freeze({
    id: 'workspace-editing',
    label: '工作区编辑',
    description: '在只读基础上，可在工作区内写入文件（每次写入需批准）。',
    allowsWrites: true,
    tools: Object.freeze(['workspace_list', 'workspace_read', 'text_search', 'workspace_write']),
  }),
  Object.freeze({
    id: 'local-commands',
    label: '本地命令',
    description: '允许受限的本地只读命令（例如 git 状态）；不是任意 shell。',
    allowsWrites: false,
    tools: Object.freeze(['workspace_list', 'workspace_read', 'text_search', 'git_status', 'git_log']),
  }),
  Object.freeze({
    id: 'external-integrations',
    label: '外部集成',
    // The preset deliberately grants no MCP or plugin tool: those are named by
    // the operator on the Agent revision, because a preset cannot know which
    // servers exist. It grants the read-only built-ins a connected Agent still
    // needs, and nothing more. The earlier description claimed it connected
    // external tools, which no code path did.
    description: '为接入外部工具的 Agent 提供只读基础工具；MCP 与插件需在 Agent 上单独授予。',
    allowsWrites: false,
    tools: Object.freeze(['workspace_list', 'workspace_read', 'text_search']),
  }),
]);

export function findCapabilityPreset(id: string): CapabilityPreset | undefined {
  return CAPABILITY_PRESETS.find((preset) => preset.id === id);
}

/** Grants for a preset, narrowed to the tools actually registered. */
export function grantsForPreset(
  id: CapabilityPresetId,
  tools: ToolProvider | undefined,
  skills: readonly SkillGrantCandidate[] | undefined,
): readonly CapabilityGrant[] {
  const preset = findCapabilityPreset(id);
  if (!preset) return Object.freeze([]);
  const available = new Set(tools?.list().map((tool) => tool.id) ?? []);
  const toolGrants = preset.tools
    .filter((name) => available.has(name))
    .map((name) => Object.freeze({ kind: 'tool' as const, name }));
  // External integrations never auto-grant skills; the operator opts in.
  const skillGrants = id === 'external-integrations'
    ? []
    : (skills ?? []).map((skill) => Object.freeze({ kind: 'skill' as const, name: skill.name }));
  return Object.freeze([...toolGrants, ...skillGrants]);
}
