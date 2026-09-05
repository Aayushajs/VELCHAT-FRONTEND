/**
 * Detecting a hole in `seq` (§L6) — the difference between a delayed message and a lost one.
 *
 * Live fan-out is best-effort: the gateway drops a push whenever it cannot resolve the
 * conversation's members (cold projection, pod restart). Say seqs 41-46 are dropped and 47 gets
 * through. The client applies 47, its cursor becomes 47, and every future reconnect asks for
 * `afterSeq=47`. 41-46 are then unreachable FOREVER — a permanent hole with no symptom, because
 * nothing ever noticed that 47 did not follow 40.
 *
 * The complication: not every hole is loss. The server omits deleted messages, so a genuine,
 * permanent gap exists in normal use. A detector that re-probes such a gap on every subsequent
 * message would turn one deleted message into an endless backfill loop.
 */
import { shouldProbeGap } from '../gapDetection';

describe('shouldProbeGap', () => {
  it('says no when the message is the next one in sequence', () => {
    expect(shouldProbeGap({ localMax: 40, incomingSeq: 41 })).toBe(false);
  });

  it('says no for a message we already hold (duplicate/replay)', () => {
    expect(shouldProbeGap({ localMax: 47, incomingSeq: 41 })).toBe(false);
  });

  it('detects the hole when a live push skips ahead', () => {
    expect(shouldProbeGap({ localMax: 40, incomingSeq: 47 })).toBe(true);
  });

  it('probes the very first message of a conversation we have nothing for', () => {
    // localMax 0 + seq 1 is not a gap; localMax 0 + seq 12 means we missed 1-11.
    expect(shouldProbeGap({ localMax: 0, incomingSeq: 1 })).toBe(false);
    expect(shouldProbeGap({ localMax: 0, incomingSeq: 12 })).toBe(true);
  });

  it('does not re-probe the same hole once it has been probed', () => {
    // The backfill ran and came back without 41-46 — they were deleted, not lost. Probing again
    // on seq 48, 49, 50… would re-fetch the same window forever.
    expect(
      shouldProbeGap({ localMax: 40, incomingSeq: 48, lastProbedFrom: 40 }),
    ).toBe(false);
  });

  it('probes again once the cursor has actually moved', () => {
    // A new hole above a previously-probed one is a genuinely different question.
    expect(
      shouldProbeGap({ localMax: 60, incomingSeq: 70, lastProbedFrom: 40 }),
    ).toBe(true);
  });

  it('ignores nonsense seqs rather than firing a backfill on them', () => {
    expect(shouldProbeGap({ localMax: 10, incomingSeq: Number.NaN })).toBe(
      false,
    );
    expect(shouldProbeGap({ localMax: 10, incomingSeq: 0 })).toBe(false);
    expect(shouldProbeGap({ localMax: 10, incomingSeq: -5 })).toBe(false);
  });
});
