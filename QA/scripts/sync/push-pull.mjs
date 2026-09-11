#!/usr/bin/env node
/**
 * One full two-way sync cycle between the Google Sheet and the local Excel report.
 *
 * This script owns the SHEETS side end-to-end (reads/writes the Sheet). It does NOT touch the
 * local .xlsx directly — that stays Python's job (`build_excel_report.py`, run right before this
 * so its own local-vs-bridge reconciliation has already happened this cycle). Running
 * `npm run qa:sync` runs both in the right order automatically.
 *
 * Column layout mirrors the local Excel's "Test Results" and "Bugs" sheets exactly (same headers,
 * same column order) so the two are directly comparable side by side.
 *
 * Requires config/qa.env:
 *   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=QA/config/google-service-account.json
 *   GOOGLE_SHEET_ID=<the id from the sheet's URL>
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import '../../lib/env.js'; // side effect only: loads QA/config/qa.env into process.env
import { SheetsClient } from './sheets-client.mjs';
import { loadBridge, saveBridge, reconcile } from './bridge.mjs';
import { bugsFormatRequests, testResultsFormatRequests } from './format.mjs';
import {
  AUTOMATED_BUG_STATUSES,
  AUTOMATED_TEST_STATUSES,
  evidenceLabel,
  latestPerTest,
  loadBugsRegistry,
  loadResults,
  loadSheetsState,
  resolveSticky,
  saveSheetsState,
} from './resolve.mjs';

const QA_DIR = resolve(import.meta.dirname, '..', '..');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing ${name} in QA/config/qa.env — see QA/RUNBOOK.md §9 (Google Sheets sync) for setup.`,
    );
    process.exit(2);
  }
  return v;
}

const TEST_RESULTS_HEADERS = ['Test', 'Device', 'Result', 'Bug', 'Evidence', 'Test ID', 'Feature'];
const BUGS_HEADERS = [
  'Bug ID',
  'Jira ID',
  'Test ID',
  'Title',
  'Severity',
  'Priority',
  'Status',
  'Layer',
  'Feature',
  'Component',
  'Environment',
  'Device',
  'OS',
  'Frequency',
  'Reproducibility',
  'Preconditions',
  'Steps to Reproduce',
  'Expected',
  'Actual',
  'User Impact',
  'Suspected Cause',
  'Root Cause',
  'Evidence',
  'First Seen',
  'Last Seen',
  'Regression',
  'Notes',
];

function rowsToMap(rows, keyCol) {
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    // header is row 0
    const key = rows[i]?.[keyCol];
    if (key) map.set(String(key), rows[i]);
  }
  return map;
}

async function syncTestResults(client, spreadsheetId, state, bridge) {
  const rows = loadResults();
  const bugs = loadBugsRegistry().bugs ?? [];
  const latest = latestPerTest(rows);
  const bugById = Object.fromEntries(bugs.map((b) => [b.id, b]));
  const testToBug = {};
  for (const b of bugs) for (const tid of b.testIds ?? []) testToBug[tid] ??= b.id;

  const sheet = await client.ensureSheet(spreadsheetId, 'Test Results');
  if (!sheet.hasFormatting) {
    await client.batchUpdate(spreadsheetId, testResultsFormatRequests(sheet.sheetId));
  }
  const existingRows = await client.getValues(spreadsheetId, 'Test Results!A1:G10000');
  const existingByKey = rowsToMap(existingRows, 5); // Test ID is column F (index 5)

  const outRows = [TEST_RESULTS_HEADERS];
  const allIds = new Set([...Object.keys(latest), ...existingByKey.keys()]);

  for (const tid of [...allIds].sort()) {
    const rec = latest[tid];
    const existingRow = existingByKey.get(tid);
    const existingResult = existingRow?.[2] ?? null;

    let title, device, freshStatus, feature;
    if (rec) {
      freshStatus = rec.status ?? 'SKIPPED';
      title = rec.title ?? tid;
      device = rec.device ?? '—';
      feature = rec.feature ?? '';
    } else {
      freshStatus = existingResult ?? 'SKIPPED';
      title = existingRow?.[0] ?? tid;
      device = existingRow?.[1] ?? '—';
      feature = existingRow?.[6] ?? '';
    }

    const myResolved = resolveSticky(
      state,
      'Test Results',
      tid,
      'Result',
      freshStatus,
      existingResult,
      AUTOMATED_TEST_STATUSES,
    );
    const result = reconcile(bridge, 'Test Results', tid, 'Result', 'sheets', myResolved);

    const bugId = testToBug[tid] ?? '';
    const bug = bugById[bugId];
    const isFailLike = result === 'FAIL' || result === 'FLAKY';
    const bugDisplay = isFailLike && bugId ? bugId : '—';
    const evidence =
      result === 'FAIL' && bug ? evidenceLabel(bug.evidence) : isFailLike ? 'Logs' : '—';

    outRows.push([title, device, result, bugDisplay, evidence, tid, feature]);
  }

  await client.clearValues(spreadsheetId, 'Test Results!A1:Z10000');
  await client.setValues(spreadsheetId, 'Test Results!A1', outRows);
  return outRows.length - 1;
}

async function syncBugs(client, spreadsheetId, state, bridge) {
  const registry = loadBugsRegistry();
  const bugs = registry.bugs ?? [];

  const sheet = await client.ensureSheet(spreadsheetId, 'Bugs');
  if (!sheet.hasFormatting) {
    await client.batchUpdate(spreadsheetId, bugsFormatRequests(sheet.sheetId));
  }
  const existingRows = await client.getValues(spreadsheetId, 'Bugs!A1:AA10000');
  const existingByKey = rowsToMap(existingRows, 0);

  const outRows = [BUGS_HEADERS];
  for (const b of bugs.sort((a, c) => a.id.localeCompare(c.id, undefined, { numeric: true }))) {
    const existingRow = existingByKey.get(b.id);
    const existingStatus = existingRow?.[6] ?? null;
    const freshStatus = b.status ?? 'Open';

    const myResolved = resolveSticky(
      state,
      'Bugs',
      b.id,
      'Status',
      freshStatus,
      existingStatus,
      AUTOMATED_BUG_STATUSES,
    );
    const status = reconcile(bridge, 'Bugs', b.id, 'Status', 'sheets', myResolved);

    const asText = (v) =>
      Array.isArray(v) ? v.map((x, i) => `${i + 1}. ${x}`).join('\n') : (v ?? '');
    outRows.push([
      b.id,
      b.jira ?? '',
      (b.testIds ?? []).join(', '),
      b.title ?? '',
      b.severity ?? '',
      b.priority ?? b.severity ?? '',
      status,
      b.layer ?? '',
      b.feature ?? '',
      b.component ?? '',
      b.environment ?? '',
      b.device ?? '',
      b.os ?? '',
      b.frequency ?? '',
      b.reproducibility ?? '',
      asText(b.preconditions),
      asText(b.steps),
      asText(b.expected),
      asText(b.actual),
      asText(b.user_impact),
      asText(b.suspected_cause),
      asText(b.rootCause),
      (b.evidence ?? []).join('\n'),
      b.firstSeen ?? '2026-09-11',
      b.lastSeen ?? '2026-09-11',
      b.regression ? 'Yes' : 'No',
      asText(b.notes),
    ]);
  }

  await client.clearValues(spreadsheetId, 'Bugs!A1:AA10000');
  await client.setValues(spreadsheetId, 'Bugs!A1', outRows);
  return outRows.length - 1;
}

async function main() {
  const keyPath = requireEnv('GOOGLE_SERVICE_ACCOUNT_KEY_PATH');
  const spreadsheetId = requireEnv('GOOGLE_SHEET_ID');
  const resolvedKeyPath =
    keyPath.startsWith('/') || /^[A-Za-z]:/.test(keyPath)
      ? keyPath
      : resolve(QA_DIR, '..', keyPath);
  if (!existsSync(resolvedKeyPath)) {
    console.error(`Service account key not found at ${resolvedKeyPath}`);
    process.exit(2);
  }

  const client = SheetsClient.fromFile(resolvedKeyPath);
  const state = loadSheetsState();
  const bridge = loadBridge();

  const testCount = await syncTestResults(client, spreadsheetId, state, bridge);
  const bugCount = await syncBugs(client, spreadsheetId, state, bridge);

  saveSheetsState(state);
  saveBridge(bridge);

  console.log(
    `Synced to Google Sheet (${spreadsheetId}): ${testCount} test rows, ${bugCount} bug rows.`,
  );
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
