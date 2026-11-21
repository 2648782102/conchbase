/**
 * The vocabulary for "how hard should the model think".
 *
 * This used to be the literal union `'low' | 'medium' | 'high'`, repeated as a
 * hand-written `=== 'x' ||` chain in five modules. The gateway publishes more
 * than that: the same catalogue offers `none`, `xhigh`, `max` and `ultra`, and
 * different models accept different subsets — one offers only `high`, another
 * offers none at all. A closed union could not express any of that, so the
 * Runtime silently sent `medium` to a model that had never heard of it.
 *
 * The type is therefore a bounded string, and authority moves to the model
 * catalogue: whatever a model publishes is what a caller may select for it.
 * `KNOWN_EFFORTS` exists for ordering and for labelling, not for validation —
 * a gateway that adds `minimal` tomorrow must keep working without a code
 * change here.
 */

/** A reasoning effort a caller asked for. Always echoed back normalised. */
export type ReasoningEffort = string;

/**
 * The order the known efforts are shown in, weakest first.
 *
 * Anything a gateway publishes that is not listed here still works; it simply
 * sorts after the known steps rather than interleaving with them.
 */
export const KNOWN_EFFORTS = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const);

/** The bound on a single effort token, so a hostile catalogue cannot bloat a row. */
const MAX_EFFORT_LENGTH = 32;
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Sort published efforts into the order a person expects to read them.
 *
 * Unknown tokens keep their published order and land after the known ones —
 * they cannot be ranked, and pretending otherwise would put `medium` before
 * something the gateway considers weaker.
 */
export function sortEfforts(efforts: readonly string[]): readonly string[] {
  const rank = (effort: string): number => {
    const index = KNOWN_EFFORTS.indexOf(effort as typeof KNOWN_EFFORTS[number]);
    return index === -1 ? KNOWN_EFFORTS.length : index;
  };
  return Object.freeze([...efforts].sort((left, right) => {
    const difference = rank(left) - rank(right);
    return difference !== 0 ? difference : 0;
  }));
}

/**
 * Read one effort token from untrusted input.
 *
 * Returns `undefined` when the value is absent — "the caller has no opinion" —
 * which is different from a rejected value. Bounding happens here so every
 * caller gets the same rule instead of each writing its own `===` chain.
 */
export function parseEffortToken(value: unknown, field = 'reasoningEffort'): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_EFFORT_LENGTH || !EFFORT_PATTERN.test(trimmed)) {
    throw new TypeError(`${field} must be a short lowercase token.`);
  }
  return trimmed;
}

/**
 * Whether a model's published levels admit this effort.
 *
 * A model that publishes no levels is treated as "no reasoning control": every
 * effort is refused, because sending one would be a value the model never
 * advertised. That is what makes the composer show a read-only chip instead of
 * a dropdown the model cannot honour.
 */
export function supportsEffort(levels: readonly string[] | undefined, effort: string): boolean {
  return levels !== undefined && levels.includes(effort);
}

/**
 * Rank lookup for labelling: 0 is the weakest step the gateway offers.
 *
 * Used by clients to render "step 2 of 4" style labels without hard-coding the
 * names they happen to know today.
 */
export function effortRank(effort: string): number {
  const index = KNOWN_EFFORTS.indexOf(effort as typeof KNOWN_EFFORTS[number]);
  return index === -1 ? KNOWN_EFFORTS.length : index;
}

/**
 * The level a model should use when the caller expressed no preference.
 *
 * "The middle of the list" is the obvious rule and the wrong one for the
 * gateway's actual catalogue: `none` is a level, not a step, so
 * `[none, low, high, max]` would default to `low` — one step above "do not
 * think", on a model whose author clearly meant `high` to be the balanced
 * choice. `none` is excluded and the middle of what is left is taken; a model
 * that publishes only `none` keeps it.
 */
export function defaultEffort(ordered: readonly string[]): string | undefined {
  const steps = ordered.filter((effort) => effort !== 'none');
  const candidates = steps.length > 0 ? steps : ordered;
  if (candidates.length === 0) return undefined;
  return candidates[Math.floor((candidates.length - 1) / 2)];
}
