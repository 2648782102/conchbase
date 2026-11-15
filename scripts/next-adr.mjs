#!/usr/bin/env node
/**
 * Allocates the next ADR filename without racing a parallel session.
 *
 * Two sessions writing "the next number" produce the same number, and the
 * duplicate is only discovered at merge time when both files already exist.
 * This reserves a number by creating the file exclusively: if another session
 * took it a moment earlier, the exclusive create fails and we try the next.
 *
 * Usage:
 *   node scripts/next-adr.mjs "Per-worktree isolation"
 *   -> docs/decisions/0078-per-worktree-isolation.md
 *
 * The file is created empty. Add the decision body, then commit.
 */
import { closeSync, existsSync, openSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  process.stderr.write('usage: node scripts/next-adr.mjs "Decision title"\n');
  process.exit(2);
}

const directory = path.join(process.cwd(), 'docs', 'decisions');
const existing = readdirSync(directory)
  .map((name) => /^(\d{4})-/.exec(name)?.[1])
  .filter((value) => value !== undefined)
  .map((value) => Number(value));
let next = (existing.length > 0 ? Math.max(...existing) : 0) + 1;

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const slug = slugify(title) || 'decision';
for (let attempt = 0; attempt < 50; attempt += 1) {
  const number = String(next).padStart(4, '0');
  const filename = path.join(directory, `${number}-${slug}.md`);
  if (existsSync(filename)) {
    next += 1;
    continue;
  }
  try {
    // `wx` fails if the path appeared between the check and the create, which is
    // exactly the race a second session would otherwise win silently.
    const handle = openSync(filename, 'wx');
    writeSync(handle, `# Decision ${number}: ${title}\n\nStatus: **draft; not accepted**\n\nDate: ${new Date().toISOString().slice(0, 10)} (Asia/Shanghai).\n`);
    closeSync(handle);
    process.stdout.write(`${path.relative(process.cwd(), filename)}\n`);
    process.exit(0);
  } catch (cause) {
    if (cause?.code !== 'EEXIST') throw cause;
    next += 1;
  }
}

process.stderr.write('could not reserve an ADR number\n');
process.exit(1);
