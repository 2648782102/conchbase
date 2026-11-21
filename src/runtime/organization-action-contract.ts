/**
 * One declarative table describing, for every organization action, which
 * fields the Runtime owns and what a model is allowed to leave out.
 *
 * Why this exists: the repair logic used to be a handful of `if (type === ...)`
 * branches scattered across the parser. Every new action or field meant editing
 * several places, and a missed edit showed up as a live failure of the form
 * "X is missing Y" for a value the Runtime could have supplied itself.
 *
 * The table does not validate. `organization-contract.ts` remains the single
 * authority for what a valid action is. This module only decides what to fill
 * in *before* that validation runs, so a model is never rejected for omitting
 * something it could not have known.
 */

export type FieldFiller =
  /** An opaque Runtime identity such as `reportId` or `attentionId`. */
  | 'runtime-id'
  /** A Runtime-attested digest. The model cannot compute a real one. */
  | 'runtime-digest'
  /** The authoritative event sequence, assigned by position. */
  | 'runtime-sequence'
  /** `scope` defaults to the action's own project. */
  | 'project-scope'
  /** A closed capability vocabulary; invalid tokens are dropped. */
  | 'default-capability'
  /** A bounded enum with a safe default; invalid values are replaced. */
  | 'enum'
  /** A numeric bound with a conservative default. */
  | 'default-number'
  /** The resolved model reference, supplied by the caller. */
  | 'resolved-model'
  /**
   * The project's active Delegation, supplied by the caller. Resuming needs a
   * delegation to revalidate, and the model cannot know which one the Runtime
   * recorded.
   */
  | 'project-delegation'
  /**
   * An opaque identity the Runtime mints when it executes the action. The model
   * cannot know it, so a supplied value is replaced by a schema-valid
   * placeholder that the executor overwrites with the real id.
   */
  | 'runtime-placeholder';

export interface FieldRule {
  readonly field: string;
  readonly filler: FieldFiller;
  /** Used by `enum` rules when the value is missing or not accepted. */
  readonly fallback?: string;
  /** Used by `enum` rules to decide whether a supplied value is acceptable. */
  readonly accepts?: readonly string[];
  /** Used by `default-number` rules. */
  readonly value?: number;
}

const DIGEST = (field: string): FieldRule => ({ field, filler: 'runtime-digest' });
const ID = (field: string): FieldRule => ({ field, filler: 'runtime-id' });
const ENUM = (field: string, fallback: string, accepts: readonly string[]): FieldRule =>
  ({ field, filler: 'enum', fallback, accepts });

export const REPORT_STATES = Object.freeze([
  'draft', 'progress', 'waiting', 'ready', 'blocked', 'failed', 'attention', 'ended',
] as const);

const CAPABILITY_PATTERN = /^cap_[a-z0-9][a-z0-9_-]{2,80}$/;

/**
 * Every action the model may emit, and the fields the Runtime repairs.
 *
 * An action absent from this map needs no repair: either its fields are all
 * model-supplied by definition, or it is not model-facing at all.
 */
export const ACTION_FIELD_RULES: Readonly<Record<string, readonly FieldRule[]>> = Object.freeze({
  record_intent: [ID('intentId'), DIGEST('bodyDigest')],
  resume_project: [{ field: 'revalidatedDelegationId', filler: 'project-delegation' }],
  create_agent: [
    DIGEST('instructionsDigest'),
    // The Runtime replaces this with the created Agent's revision id. A model
    // cannot know a future `agr_` id, and rejecting its placeholder would fail
    // a plan the Runtime can complete.
    { field: 'agentRevisionId', filler: 'runtime-placeholder' },
    { field: 'scope', filler: 'project-scope' },
    { field: 'capabilities', filler: 'default-capability' },
    { field: 'model', filler: 'resolved-model' },
    { field: 'maxDelegationDepth', filler: 'default-number', value: 0 },
    { field: 'ttlEvents', filler: 'default-number', value: 100 },
  ],
  report_worker: [
    ID('reportId'),
    DIGEST('summaryDigest'),
    ENUM('state', 'ready', REPORT_STATES),
  ],
  request_attention: [
    ID('attentionId'),
    DIGEST('questionDigest'),
  ],
  answer_attention: [
    ID('attentionId'),
    DIGEST('decisionDigest'),
  ],
  withdraw_attention: [ID('attentionId'), DIGEST('decisionDigest')],
  expire_attention: [ID('attentionId'), DIGEST('decisionDigest')],
});

/** Actions that always carry both a Runtime sequence and a project id. */
export function rulesFor(type: string): readonly FieldRule[] {
  return ACTION_FIELD_RULES[type] ?? Object.freeze([]);
}

function stableHash(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Deterministic repair. Given one raw action, returns a copy whose
 * Runtime-owned fields are present and well-formed. Supplied values for
 * Runtime-owned fields are replaced rather than trusted.
 */
export function repairActionFields(
  action: Readonly<Record<string, unknown>>,
  sequence: number,
  context: {
    readonly model?: { readonly providerId: string; readonly modelId: string };
    /** The project's active delegation id, when the caller knows it. */
    readonly delegationId?: string;
  } = {},
): Readonly<Record<string, unknown>> {
  const type = typeof action.type === 'string' ? action.type : '';
  const rules = rulesFor(type);
  const next: Record<string, unknown> = { ...action, expectedSequence: sequence };
  if (rules.length === 0) return next;

  const projectId = typeof next.projectId === 'string' ? next.projectId : 'project';
  for (const rule of rules) {
    switch (rule.filler) {
      case 'runtime-id':
        next[rule.field] = `runtime_${type}_${stableHash(`${type}:${projectId}:${String(next.workerId ?? '')}:${String(next.scope ?? '')}`)}`;
        break;
      case 'runtime-digest':
        next[rule.field] = 'sha256:runtime-attested';
        break;
      case 'runtime-sequence':
        next[rule.field] = sequence;
        break;
      case 'project-scope': {
        const declared = Array.isArray(next.scope) ? next.scope : [];
        if (declared.length === 0) next.scope = [`project:${projectId}`];
        break;
      }
      case 'default-capability': {
        const declared = Array.isArray(next.capabilities)
          ? next.capabilities.filter((entry) =>
            typeof entry === 'string' && CAPABILITY_PATTERN.test(entry))
          : [];
        next.capabilities = declared.length > 0 ? declared : ['cap_read_context'];
        break;
      }
      case 'enum': {
        const current = next[rule.field];
        if (typeof current !== 'string' || !rule.accepts?.includes(current)) {
          next[rule.field] = rule.fallback;
        }
        break;
      }
      case 'default-number': {
        const current = next[rule.field];
        if (typeof current !== 'number' || !Number.isFinite(current)) {
          next[rule.field] = rule.value;
        }
        break;
      }
      case 'project-delegation': {
        // A supplied value is not trusted: the Runtime knows which delegation it
        // recorded for this project, and resuming must revalidate that one.
        if (context.delegationId) next[rule.field] = context.delegationId;
        else delete next[rule.field];
        break;
      }
      case 'resolved-model': {
        // The model reference is operator configuration, not model output. A
        // supplied value is kept only when it is well formed; otherwise the
        // caller's resolved reference wins.
        const current = next.model;
        const valid = typeof current === 'object' && current !== null
          && typeof (current as Record<string, unknown>).providerId === 'string'
          && typeof (current as Record<string, unknown>).modelId === 'string';
        if (!valid && context.model) next.model = context.model;
        break;
      }
      case 'runtime-placeholder': {
        // Must satisfy the opaque-reference grammar so validation accepts it;
        // the executor replaces it with the real id before the action is applied.
        next[rule.field] = `placeholder_${type}_${stableHash(`${type}:${projectId}:${rule.field}`)}`;
        break;
      }
    }
  }
  return next;
}
