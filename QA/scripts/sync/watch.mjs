#!/usr/bin/env node
/**
 * Continuous two-way sync (§ "jab bhi change ho, dono taraf update ho jaaye").
 *
 * Runs until you stop it (Ctrl+C). Two triggers:
 *   - Local edit  -> near-instant: an fs.watch on the local .xlsx fires a sync cycle ~1.5s after
 *                    the last write settles (Excel writes a file in several steps; the debounce
 *                    avoids syncing a half-written file).
 *   - Sheets edit -> detected within one poll interval (default 20s). Google Sheets has no simple
 *                    push-notification API without a public webhook endpoint (Apps Script + a
 *                    reachable HTTPS callback) — a short poll is the practical equivalent without
 *                    standing up extra infrastructure, and is indistinguishable in practice for a
 *                    bug tracker that a person edits occasionally.
 *
 * A cycle is: rebuild the local Excel (pulls any Sheets-side edit down via the bridge, and
 * announces any local edit up) → push/pull the Sheet (mirrors that both ways too). Both halves
 * always run together so the bridge only ever has one cycle's worth of lag between them.
 *
 * Meant to be left running — e.g. in its own terminal, or wired to start on login. It is a plain
 * Node process; it is NOT something Claude keeps running for you between conversations.
 */
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const QA_DIR = resolve(import.meta.dirname, '..', '..');
const XLSX_PATH = resolve(QA_DIR, 'reports', 'VelChat-QA-Report.xlsx');
const POLL_INTERVAL_MS = Number(process.env.QA_SYNC_POLL_MS ?? 20_000);
const DEBOUNCE_MS = 1500;

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
    p.on('error', rej);
  });
}

let running = false;
let queued = false;

async function cycle(reason) {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  const at = new Date().toISOString();
  console.log(`[watch ${at}] syncing (${reason})…`);
  try {
    await run('python', [resolve(QA_DIR, 'scripts', 'build_excel_report.py')]);
    await run('node', [resolve(QA_DIR, 'scripts', 'sync', 'push-pull.mjs')]);
    console.log(`[watch ${at}] done.`);
  } catch (e) {
    console.error(`[watch ${at}] sync failed:`, e.message ?? e);
  } finally {
    running = false;
    if (queued) {
      queued = false;
      cycle('queued change');
    }
  }
}

let debounce;
try {
  watch(XLSX_PATH, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => cycle('local file changed'), DEBOUNCE_MS);
  });
} catch (e) {
  console.warn(
    `[watch] could not watch ${XLSX_PATH} (${e.message}) — local edits will only sync via the poll timer.`,
  );
}

setInterval(() => cycle('poll'), POLL_INTERVAL_MS);

console.log(`[watch] watching ${XLSX_PATH}`);
console.log(`[watch] polling the Google Sheet every ${POLL_INTERVAL_MS / 1000}s`);
console.log('[watch] Ctrl+C to stop.\n');

cycle('startup');
