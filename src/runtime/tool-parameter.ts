/**
 * Reading a tool's declared parameters.
 *
 * Three modules had grown their own reader: `asString` in the read tools (with
 * an optional fallback), `asString` again in the write tools (required, no
 * fallback), and `requireString` in the git tools — byte-for-byte the strict
 * variant under a different name. The two shapes are genuinely different, so
 * both are kept, but named so a caller cannot pick the wrong one by accident:
 *
 * - `requiredString` fails when the key is absent or empty;
 * - `optionalString` returns the fallback when the key is absent, and still
 *   fails when it is present but not a string.
 *
 * Both reject non-strings rather than coercing: a model sending `{"path": 5}`
 * is a mistake worth surfacing, not something to silently stringify.
 *
 * Distinct from `tool-arguments.ts`, which computes the *identity* of a set of
 * arguments; this module reads their *values*.
 */
import { ToolRejectedError, type ToolArguments } from './tool-provider.js';

export function requiredString(args: ToolArguments, key: string, label = key): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolRejectedError('invalid_arguments', `${label} must be a non-empty string.`);
  }
  return value;
}

export function optionalString(args: ToolArguments, key: string, fallback = ''): string {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new ToolRejectedError('invalid_arguments', `${key} must be a string.`);
  }
  return value;
}
