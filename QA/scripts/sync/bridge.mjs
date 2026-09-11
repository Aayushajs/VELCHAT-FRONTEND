/**
 * The sync bridge — the shared ledger that lets a manual edit made in ONE surface (local Excel or
 * the Google Sheet) propagate into the OTHER, without either surface needing to read the other's
 * native file format directly.
 *
 * `QA/reports/.sync_bridge.json` holds, per (sheet, key, column), the last value either side
 * confirmed as "the current human-facing truth" and who set it:
 *   { "Test Results": { "VC-RT-021": { "Result": { value, updatedAt, source } } }, "Bugs": {...} }
 *
 * How each side uses it (see build_excel_report.py's `resolve_sticky` for the local half, and
 * push-pull.mjs for the Sheets half — both follow the same shape):
 *   1. Resolve your OWN sticky value normally (is this cell a human edit relative to what I,
 *      personally, last wrote here?).
 *   2. If YES (a fresh human edit on your side) — write it to the bridge so the other surface
 *      picks it up on its next sync.
 *   3. If NO (your cell still matches what you last wrote) — check whether the bridge holds a
 *      NEWER value from the OTHER surface; if so, adopt it (pull the other side's edit in).
 *   4. If both surfaces disagree with the bridge AND with each other in the same cycle, the more
 *      recent `updatedAt` wins and a warning is logged — this is intentionally last-write-wins,
 *      not a full conflict UI, which is the right tradeoff for a low-frequency bug tracker.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BRIDGE_PATH = resolve(import.meta.dirname, '..', '..', 'reports', '.sync_bridge.json');

export function loadBridge() {
  if (!existsSync(BRIDGE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BRIDGE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveBridge(bridge) {
  writeFileSync(BRIDGE_PATH, `${JSON.stringify(bridge, null, 2)}\n`, 'utf8');
}

function entry(bridge, sheet, key, column) {
  return bridge?.[sheet]?.[key]?.[column] ?? null;
}

function setEntry(bridge, sheet, key, column, value, source) {
  bridge[sheet] ??= {};
  bridge[sheet][key] ??= {};
  bridge[sheet][key][column] = { value, source, updatedAt: new Date().toISOString() };
}

/**
 * Reconcile one cell against the bridge from the perspective of `source` ("local" or "sheets").
 *
 * @param bridge      the loaded bridge object (mutated in place)
 * @param sheet       "Test Results" | "Bugs"
 * @param key         Test ID / Bug ID
 * @param column      "Result" | "Status"
 * @param source      which surface is calling ("local" | "sheets")
 * @param myResolved  {value, isManual} — this surface's OWN sticky-resolved value, computed
 *                    exactly as before (fresh-vs-my-own-last-baseline), ignoring the other side
 * @returns the FINAL value this surface should actually write for this cell
 */
export function reconcile(bridge, sheet, key, column, source, myResolved) {
  const other = source === 'local' ? 'sheets' : 'local';
  const existing = entry(bridge, sheet, key, column);

  if (myResolved.isManual) {
    // I just detected a fresh human edit on MY side. If the other side independently made a
    // DIFFERENT manual edit that the bridge doesn't yet know about, that's a genuine same-cycle
    // conflict — last writer (by wall-clock "now") wins; log it so it's visible, not silent.
    if (existing && existing.source === other && existing.value !== myResolved.value) {
      console.warn(
        `[sync] conflict on ${sheet}/${key}/${column}: local="${source === 'local' ? myResolved.value : existing.value}" ` +
          `sheets="${source === 'sheets' ? myResolved.value : existing.value}" — keeping the one just written (${source}).`,
      );
    }
    setEntry(bridge, sheet, key, column, myResolved.value, source);
    return myResolved.value;
  }

  // My side has no new manual edit. If the bridge holds a value from the OTHER surface that I
  // don't already reflect, pull it in.
  if (existing && existing.source === other && existing.value !== myResolved.value) {
    return existing.value;
  }

  // Nothing to reconcile — my own fresh/automated value stands, and if it's the first time this
  // key has ever synced, record it so future runs have a baseline.
  if (!existing) {
    setEntry(bridge, sheet, key, column, myResolved.value, 'automated');
  }
  return myResolved.value;
}
