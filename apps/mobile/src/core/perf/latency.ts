/**
 * Chat latency instrumentation (§M0 rule 5 — "everything is measured", §R4 budgets).
 *
 * The budgets that decide whether this feels like WhatsApp are all end-to-end timings that no
 * unit test can observe: how long from tapping send to the bubble painting, from tapping send to
 * the server's ack, from a frame arriving to the row existing locally. Without numbers, "it feels
 * slow" is unactionable and a regression only surfaces as a complaint.
 *
 * Design constraints, because this runs on the message hot path:
 *   - O(1) per sample and allocation-free in the common case — a ring buffer of raw numbers, no
 *     objects, no arrays-of-arrays, no string keys built per sample.
 *   - Bounded memory forever (§M0 rule: no unbounded caches). Percentiles come from a fixed
 *     window, not from history.
 *   - Never throws, never awaits, never touches the network. A broken metric must not be able to
 *     break a send.
 */
import { log } from '../logger';

/** Spans worth budgeting. Keep this list short — every entry is a live ring buffer. */
export type LatencySpan =
  /** tap send → optimistic bubble committed locally (target: ≤20 ms p50, §L7). */
  | 'send.local'
  /** tap send → server ack persisted (network-bound; the "did it go?" feeling). */
  | 'send.ack'
  /** inbound frame received → row applied to the local DB (the "did it arrive?" feeling). */
  | 'recv.apply'
  /** socket close → next socket open (how long realtime was actually down). */
  | 'ws.reconnect';

/** Samples kept per span. 128 × 4 spans × 8 bytes ≈ 4 KB — a rounding error against §R5. */
const WINDOW = 128;

interface Ring {
  readonly buf: Float64Array;
  n: number; // total samples ever (for count)
  i: number; // next write index
}

const rings = new Map<LatencySpan, Ring>();

function ringFor(span: LatencySpan): Ring {
  let r = rings.get(span);
  if (!r) {
    r = { buf: new Float64Array(WINDOW), n: 0, i: 0 };
    rings.set(span, r);
  }
  return r;
}

/** Record one measurement, in milliseconds. Silently ignores nonsense rather than skewing a budget. */
export function recordLatency(span: LatencySpan, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const r = ringFor(span);
  r.buf[r.i] = ms;
  r.i = (r.i + 1) % WINDOW;
  r.n += 1;
}

/**
 * Time an operation and record it. Returns whatever the operation returned, so it can wrap a call
 * site without restructuring it. A throw is still timed — a slow failure is a latency fact too.
 */
export async function timed<T>(
  span: LatencySpan,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    recordLatency(span, Date.now() - t0);
  }
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** Percentiles over the current window. Copies + sorts at most WINDOW numbers — reporting only. */
export function latencyStats(span: LatencySpan): LatencyStats | null {
  const r = rings.get(span);
  if (!r || r.n === 0) return null;
  const size = Math.min(r.n, WINDOW);
  const sample = Array.from(r.buf.subarray(0, size)).sort((a, b) => a - b);
  const at = (p: number): number =>
    sample[Math.min(size - 1, Math.floor(p * size))] ?? 0;
  return {
    count: r.n,
    p50: at(0.5),
    p95: at(0.95),
    max: sample[size - 1] ?? 0,
  };
}

/** Every span that has data — for a diagnostics screen or a one-line log. */
export function allLatencyStats(): Record<string, LatencyStats> {
  const out: Record<string, LatencyStats> = {};
  for (const span of rings.keys()) {
    const s = latencyStats(span);
    if (s) out[span] = s;
  }
  return out;
}

/**
 * Emit the current picture to the logger. Called on a long interval (or from a debug action) —
 * never per message, which would make the instrumentation cost more than what it measures.
 */
export function logLatencySnapshot(): void {
  const stats = allLatencyStats();
  if (Object.keys(stats).length === 0) return;
  log.info('chat latency', stats);
}

/** Logout / test isolation — a new session must not inherit the old one's numbers. */
export function resetLatency(): void {
  rings.clear();
}
