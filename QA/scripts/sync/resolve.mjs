/**
 * The Sheets-side mirror of build_excel_report.py's sticky-column logic — same semantics, same
 * sidecar-state trick (track OUR OWN last-computed automated baseline, never what got written),
 * ported to JS so the Google Sheet can independently detect "did a human edit this cell" exactly
 * the way the local Excel does. See QA/scripts/build_excel_report.py's `resolve_sticky` docstring
 * for the full reasoning; this is a deliberate line-for-line port, not a reinterpretation.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const QA_DIR = pathResolve(import.meta.dirname, '..', '..');
const REPORTS = pathResolve(QA_DIR, 'reports');
const STATE_PATH = pathResolve(REPORTS, '.sheets_state.json');

export const AUTOMATED_TEST_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY']);
export const AUTOMATED_BUG_STATUSES = new Set([
  'Open',
  'Fixed',
  "Won't Fix",
  'In Progress',
  'Closed',
  'Duplicate',
]);

export function loadSheetsState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveSheetsState(state) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Same algorithm as Python's `resolve_sticky`: the state tracks the AUTOMATED value we computed
 * last time (never the human override), so comparing the sheet's current value against that
 * baseline correctly detects a human edit on every run.
 */
export function resolveSticky(state, sheet, key, column, freshValue, existingValue, automatedSet) {
  state[sheet] ??= {};
  state[sheet][key] ??= {};
  const lastFresh = state[sheet][key][column];

  let result;
  if (existingValue === null || existingValue === undefined || existingValue === '') {
    result = freshValue;
  } else if (lastFresh === undefined) {
    result = automatedSet.has(String(existingValue)) ? freshValue : existingValue;
  } else if (String(existingValue) === String(lastFresh)) {
    result = freshValue;
  } else {
    result = existingValue;
  }

  const isManual = !automatedSet.has(String(result));
  state[sheet][key][column] = freshValue;
  return { value: result, isManual };
}

export function loadResults() {
  const path = pathResolve(REPORTS, 'results.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function loadBugsRegistry() {
  const path = pathResolve(REPORTS, 'bugs.json');
  if (!existsSync(path)) return { meta: {}, bugs: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function latestPerTest(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.testId) continue;
    if (!out[r.testId] || (r.at ?? '') >= (out[r.testId].at ?? '')) out[r.testId] = r;
  }
  return out;
}

export function evidenceLabel(paths) {
  if (!paths?.length) return '—';
  const joined = paths.join(' ').toLowerCase();
  const kinds = [];
  if (/\.(png|jpg)|screenshot/.test(joined)) kinds.push('Screenshot');
  if (/\.(mp4|mov)|video/.test(joined)) kinds.push('Video');
  if (/\.(log|jsonl|txt)|logs/.test(joined)) kinds.push('Logs');
  if (/\.md/.test(joined)) kinds.push('Audit');
  if (/\.(mjs|js|sh)/.test(joined)) kinds.push('Repro script');
  return kinds.length ? [...new Set(kinds)].join(' + ') : 'Attached';
}
