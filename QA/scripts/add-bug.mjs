#!/usr/bin/env node
/**
 * Append ONE new bug to QA/reports/bugs.json with a guaranteed-next, never-reused id (§43).
 *
 * This is the only sanctioned way to add a bug by hand — it removes the chance of a manual typo
 * creating a duplicate id or skipping/renumbering the sequence, which is the exact thing the user
 * asked never to happen.
 *
 * Usage:
 *   node QA/scripts/add-bug.mjs path/to/new-bug.json
 *   node QA/scripts/add-bug.mjs '{"title":"...", "severity":"P1", ...}'
 *
 * The input's `id` field (if any) is IGNORED and overwritten with the computed next id.
 * Refuses to run if a bug with the same title already exists (case-insensitive), as a cheap
 * duplicate guard beyond the id sequence itself.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextBugId } from './lib/bug_ids.mjs';

const REGISTRY = resolve(import.meta.dirname, '..', 'reports', 'bugs.json');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node QA/scripts/add-bug.mjs <path-to-json | inline-json>');
  process.exit(2);
}

const raw = existsSync(arg) ? readFileSync(arg, 'utf8') : arg;
const draft = JSON.parse(raw);

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

const dup = registry.bugs.find(
  (b) =>
    b.title.trim().toLowerCase() ===
    String(draft.title ?? '')
      .trim()
      .toLowerCase(),
);
if (dup) {
  console.error(`Refusing to add: a bug with this exact title already exists as ${dup.id}.`);
  console.error(
    'If this is genuinely the same defect, do not create a new entry — update the existing one instead.',
  );
  process.exit(1);
}

const id = nextBugId(registry.bugs);
const bug = {
  id,
  status: 'Open',
  regression: false,
  evidence: [],
  refs: [],
  testIds: [],
  ...draft,
  ...{ id }, // id is never overridable by the draft
};

registry.bugs.push(bug);
registry.bugs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

console.log(`Added ${id}: ${bug.title}`);
console.log(`Registry now holds ${registry.bugs.length} bugs.`);
console.log(
  `Run "npm run qa:jira" to file it, and "npm run qa:report" to refresh the Excel report.`,
);
