/**
 * Sequence-gap detection (§L6) — pure, NO I/O.
 *
 * Live fan-out is best-effort by design: the gateway drops a push it cannot route (cold
 * membership projection, pod restart), and the client's REST catch-up is the durability
 * backstop. That backstop only works if the client NOTICES the hole — otherwise applying the
 * message that skipped ahead advances the cursor past the missing ones, and no future
 * `afterSeq` request can ever reach them again. Silent, permanent loss.
 *
 * The subtlety is that a hole is not proof of loss: deleted messages are omitted from history,
 * so a permanent, legitimate gap is normal. Probing it once is correct; probing it again on
 * every subsequent message would turn one deleted message into an endless backfill loop. So a
 * probe is remembered by the cursor it ran from, and only a cursor that has actually moved
 * earns another.
 */

export interface GapProbeInput {
  /** Highest seq we currently hold for the conversation (0 when we hold none). */
  localMax: number;
  /** Seq of the message that just arrived. */
  incomingSeq: number;
  /** `localMax` at the time of the last probe for this conversation, if any. */
  lastProbedFrom?: number | undefined;
}

export function shouldProbeGap(input: GapProbeInput): boolean {
  const { localMax, incomingSeq, lastProbedFrom } = input;
  if (!Number.isFinite(incomingSeq) || incomingSeq <= 0) return false;
  // Not ahead of us at all — a duplicate or an out-of-order replay, not a hole.
  if (incomingSeq <= localMax + 1) return false;
  // Already asked this exact question and the server had nothing more to give.
  if (lastProbedFrom !== undefined && lastProbedFrom >= localMax) return false;
  return true;
}
