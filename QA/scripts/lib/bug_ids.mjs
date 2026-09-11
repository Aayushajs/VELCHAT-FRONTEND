/**
 * Bug-ID allocation (§43) — the ONE place a new bug id is ever computed, so numbering can never
 * skip, reuse, or renumber. `VC-001..VC-999` are zero-padded to 3 digits; beyond that width just
 * grows naturally (VC-1000).
 *
 * Usage:
 *   import { nextBugId } from './lib/bug_ids.mjs';
 *   const id = nextBugId(registry.bugs);   // always current-max + 1, never a gap-fill
 */
export function nextBugId(bugs) {
  const max = bugs.reduce((m, b) => {
    const n = Number(String(b.id).replace(/^VC-0*/, ''));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  const next = max + 1;
  return `VC-${String(next).padStart(3, '0')}`;
}

/** True if a bug with this id already exists — the ONLY guard that may block adding a new entry. */
export function bugExists(bugs, id) {
  return bugs.some((b) => b.id === id);
}
