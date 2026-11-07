import { createHash } from 'node:crypto';

export type ConfigurationRevisionId = string & { readonly __brand: 'ConfigurationRevisionId' };

export interface ConfigurationRevisionInput {
  readonly profile: readonly string[];
  readonly skills: readonly string[];
  readonly policies: readonly string[];
  readonly mcpServers: readonly string[];
}

export interface ConfigurationRevision extends ConfigurationRevisionInput {
  readonly id: ConfigurationRevisionId;
}

type ConfigurationSection = keyof ConfigurationRevisionInput;

const SECTIONS: readonly ConfigurationSection[] = [
  'profile',
  'skills',
  'policies',
  'mcpServers',
];

function normalizeSection(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort();
}

export function createConfigurationRevision(
  input: ConfigurationRevisionInput,
): ConfigurationRevision {
  const normalized = Object.fromEntries(
    SECTIONS.map((section) => [section, normalizeSection(input[section])]),
  ) as unknown as ConfigurationRevisionInput;

  const digest = createHash('sha256')
    .update('conchbase-configuration-revision-v1\0')
    .update(JSON.stringify(normalized))
    .digest('hex')
    .slice(0, 24);

  return Object.freeze({
    id: `cfg_${digest}` as ConfigurationRevisionId,
    ...normalized,
  });
}

export interface ConfigurationRevisionStore {
  active: ConfigurationRevision;
  readonly history: readonly ConfigurationRevision[];
}

export function createConfigurationRevisionStore(
  initial: ConfigurationRevisionInput,
): ConfigurationRevisionStore {
  const revision = createConfigurationRevision(initial);
  return { active: revision, history: Object.freeze([revision]) };
}

export function applyConfigurationRevision(
  store: ConfigurationRevisionStore,
  input: ConfigurationRevisionInput,
): ConfigurationRevisionStore {
  const candidate = createConfigurationRevision(input);
  if (candidate.id === store.active.id) return store;

  return {
    active: candidate,
    history: Object.freeze([...store.history, candidate]),
  };
}
