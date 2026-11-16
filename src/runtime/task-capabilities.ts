import type { AgentId, AgentRevisionId } from './agent-profile.js';
import { projectSkills, projectToolProvider } from './capability-grants.js';
import type { TaskStore } from './task-store.js';
import type { SkillGrantCandidate } from './capability-grants.js';
import type { ToolProvider } from './tool-provider.js';

/**
 * What one task is allowed to use.
 *
 * Capabilities are pinned to the Agent revision a task was created with, never
 * to the Agent's current revision: editing an Agent must not retroactively widen
 * a running task. Grants can only narrow the Runtime-wide providers, and a task
 * with no Agent gets no tools and no Skills at all.
 */
export interface TaskCapabilities {
  readonly tools: ToolProvider | undefined;
  readonly skills: readonly SkillGrantCandidate[];
}

export interface CapabilityProviders {
  readonly tools?: ToolProvider;
  readonly skills?: readonly SkillGrantCandidate[];
}

/**
 * Resolves the capabilities for one task from its pinned revision.
 *
 * This is a security boundary, so it is a named function with its own tests
 * rather than an inline branch inside the loop: a mistake here silently widens
 * what a model can do.
 */
export function resolveTaskCapabilities(
  store: Pick<TaskStore, 'getAgentRevision'>,
  providers: CapabilityProviders,
  task: { readonly agentId?: AgentId; readonly agentRevisionId?: AgentRevisionId },
): TaskCapabilities {
  if (!task.agentId) return Object.freeze({ tools: undefined, skills: Object.freeze([]) });
  const revision = task.agentRevisionId
    ? store.getAgentRevision(task.agentId, task.agentRevisionId)
    : null;
  const grants = revision?.grantedCapabilities ?? Object.freeze([]);
  return Object.freeze({
    tools: projectToolProvider(providers.tools, grants),
    skills: projectSkills(providers.skills, grants),
  });
}
