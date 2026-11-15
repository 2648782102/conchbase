#!/usr/bin/env node
/**
 * Splits the two append-only arrays of docs/PROJECT_STATUS.json into one file
 * per record, and merges them back.
 *
 * Why: `implemented` and `validationEvidence` grow by appending. Two sessions
 * appending to the same JSON array conflict on almost every parallel branch, and
 * the conflict is a brace-level merge in a 34 KB file. One file per record makes
 * an addition a new file, which Git merges without conflict.
 *
 * The published status file stays the single readable artifact; these slices are
 * the source it is generated from.
 *
 * Usage:
 *   node scripts/status-slices.mjs split    # JSON -> docs/status/*.json
 *   node scripts/status-slices.mjs merge    # docs/status/*.json -> JSON
 *   node scripts/status-slices.mjs check    # fail if JSON and slices disagree
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const statusPath = path.join(root, 'docs', 'PROJECT_STATUS.json');
const sliceDir = path.join(root, 'docs', 'status');
const SLICED = ['implemented', 'validationEvidence'];

function readStatus() {
  return JSON.parse(readFileSync(statusPath, 'utf8'));
}

function sliceFile(kind, id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(sliceDir, kind, `${safe}.json`);
}

function split() {
  const status = readStatus();
  rmSync(sliceDir, { recursive: true, force: true });
  for (const kind of SLICED) {
    mkdirSync(path.join(sliceDir, kind), { recursive: true });
    const seen = new Set();
    for (const record of status[kind] ?? []) {
      if (!record || typeof record.id !== 'string') {
        throw new Error(`${kind} record without an id cannot be sliced`);
      }
      if (seen.has(record.id)) throw new Error(`duplicate ${kind} id: ${record.id}`);
      seen.add(record.id);
      writeFileSync(sliceFile(kind, record.id), `${JSON.stringify(record, null, 2)}\n`);
    }
    // The published file keeps the array so nothing that reads it has to change.
    status[kind] = [];
  }
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  process.stdout.write(`split ${SLICED.join(', ')} -> docs/status/\n`);
}

function readSlices(kind) {
  const directory = path.join(sliceDir, kind);
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const record = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
    if (!record || typeof record.id !== 'string') {
      throw new Error(`docs/status/${kind}/${name} has no id`);
    }
    return record;
  });
}

function merge() {
  const status = readStatus();
  for (const kind of SLICED) {
    const records = readSlices(kind);
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.id)) throw new Error(`duplicate ${kind} id across slices: ${record.id}`);
      seen.add(record.id);
    }
    status[kind] = records;
  }
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  process.stdout.write(`merged docs/status/ -> ${path.relative(root, statusPath)}\n`);
}

function check() {
  const status = readStatus();
  const problems = [];
  for (const kind of SLICED) {
    const fromSlices = readSlices(kind);
    const inJson = status[kind] ?? [];
    const sliceIds = fromSlices.map((record) => record.id).sort();
    const jsonIds = inJson.map((record) => record?.id).sort();
    if (JSON.stringify(sliceIds) !== JSON.stringify(jsonIds)) {
      problems.push(`${kind}: PROJECT_STATUS.json and docs/status/ disagree (${jsonIds.length} vs ${sliceIds.length})`);
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\nrun: node scripts/status-slices.mjs merge\n`);
    process.exit(1);
  }
  process.stdout.write('status slices agree with PROJECT_STATUS.json\n');
}

const command = process.argv[2];
if (command === 'split') split();
else if (command === 'merge') merge();
else if (command === 'check') check();
else {
  process.stderr.write('usage: node scripts/status-slices.mjs <split|merge|check>\n');
  process.exit(2);
}
