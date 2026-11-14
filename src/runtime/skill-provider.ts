import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_SKILLS = 8;
const DEFAULT_MAX_BYTES = 8 * 1024;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

export interface SkillSet {
  readonly skills: readonly Skill[];
  readonly instructions: string;
}

export interface LoadSkillOptions {
  readonly directory: string;
  readonly maxSkills?: number;
  readonly maxInstructionsBytes?: number;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function stripFrontMatter(source: string): { meta: Record<string, string>; body: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: normalized };
  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const meta: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,31}):\s*(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) meta[match[1]] = match[2].trim();
  }
  return { meta, body };
}

function resolveInside(root: string, candidate: string): string | null {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(candidate);
  } catch {
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) return null;
  return realTarget;
}

function readSkill(root: string, directoryName: string): Skill | null {
  if (!NAME_PATTERN.test(directoryName)) return null;
  const directory = resolveInside(root, path.join(root, directoryName));
  if (!directory) return null;
  try {
    if (!statSync(directory).isDirectory()) return null;
  } catch {
    return null;
  }
  const file = path.join(directory, 'SKILL.md');
  const resolvedFile = resolveInside(root, file);
  if (!resolvedFile) return null;
  let source: string;
  try {
    if (statSync(resolvedFile).size > MAX_SKILL_FILE_BYTES) return null;
    source = readFileSync(resolvedFile, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = stripFrontMatter(source);
  const instructions = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
  if (instructions.length === 0) return null;
  const declared = meta.name && NAME_PATTERN.test(meta.name) ? meta.name : directoryName;
  return Object.freeze({
    name: declared,
    description: (meta.description ?? '').slice(0, 240),
    instructions,
  });
}

export function loadSkillDirectory(options: LoadSkillOptions): SkillSet {
  const maxSkills = bounded(options.maxSkills, DEFAULT_MAX_SKILLS, 1, 32);
  const maxBytes = bounded(options.maxInstructionsBytes, DEFAULT_MAX_BYTES, 256, 64 * 1024);
  let entries: string[];
  try {
    entries = readdirSync(options.directory).sort();
  } catch {
    return Object.freeze({ skills: Object.freeze([]), instructions: '' });
  }
  const skills: Skill[] = [];
  let instructions = '';
  for (const entry of entries) {
    if (skills.length >= maxSkills) break;
    const skill = readSkill(options.directory, entry);
    if (!skill) continue;
    const section = `### ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${skill.instructions}`;
    const separator = instructions.length > 0 ? '\n\n' : '';
    const remaining = maxBytes - Buffer.byteLength(instructions, 'utf8') - Buffer.byteLength(separator, 'utf8');
    if (remaining <= 0) break;
    const sectionBytes = Buffer.byteLength(section, 'utf8');
    if (sectionBytes <= remaining) {
      skills.push(skill);
      instructions += `${separator}${section}`;
      continue;
    }
    const truncated = Buffer.from(section, 'utf8').subarray(0, remaining).toString('utf8');
    skills.push(Object.freeze({ ...skill, instructions: truncated }));
    instructions += `${separator}${truncated}`;
    break;
  }
  return Object.freeze({
    skills: Object.freeze(skills),
    instructions,
  });
}
