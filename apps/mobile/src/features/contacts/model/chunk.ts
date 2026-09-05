/**
 * Chunked, yielding iteration (§M0.4 "zero jank on the JS thread", §M20).
 *
 * WHY: the contacts pipeline is three long synchronous passes over the whole address book —
 * E.164 normalization, fingerprinting, and (in the OPRF layer) blinding. Measured on a
 * 2000-contact book, normalization alone is a single ~70 ms burst on desktop V8, several
 * hundred ms on the reference device. Any pass that runs to completion in one turn holds the
 * JS thread for its entire duration: every frame inside it is dropped and the screen looks
 * frozen — which is exactly the reported "load time bahut jyada" on a big phone book.
 *
 * Slicing the pass and awaiting a macrotask between slices caps the longest single JS block at
 * ONE slice, so the list keeps painting and scrolling while the rest of the work drains behind
 * it. The total CPU is unchanged (slightly higher, in fact) — what changes is that it is no
 * longer one unbroken block.
 *
 * The yield and the cancel check are INJECTED so the slicing logic is unit-testable without
 * timers: a test passes a synchronous resolver and asserts *what* was processed, never *when*.
 */

/**
 * Yield to the event loop so queued work (touch handling, layout, a pending render) can run
 * before the next slice. `setTimeout(0)` is a MACROtask on purpose — a promise microtask would
 * drain in the same turn and yield nothing at all.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

/**
 * Wait until the JS thread has nothing better to do, then continue.
 *
 * Used to keep whole-book work (the launch prewarm, a silent refresh behind an already-painted
 * list) out of the frames that matter — cold start (§R4 ≤2.0 s) and the New Chat open transition.
 *
 * `requestIdleCallback` rather than `InteractionManager`: the latter is deprecated in RN 0.86 and
 * warns on every access. The `timeout` guarantees the work still runs on a device that never goes
 * idle, and the `setTimeout` fallback covers environments without the polyfill (Jest, and any
 * runtime where the global is missing).
 */
export function whenIdle(timeoutMs = 1000): Promise<void> {
  return new Promise(resolve => {
    const ric = (
      globalThis as {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout: number },
        ) => unknown;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => resolve(), { timeout: timeoutMs });
      return;
    }
    setTimeout(resolve, 0);
  });
}

export interface ChunkedOptions {
  /** Items per slice. Smaller = smoother, more overhead. */
  size?: number;
  /** Injected for tests; defaults to a real macrotask yield. */
  yieldFn?: () => Promise<void>;
  /** Checked between slices — lets a stale run abandon its remaining work. */
  isCancelled?: () => boolean;
}

/**
 * Slice size tuned against the frame budget: ~200 contacts of E.164 normalization is well
 * under one 16 ms frame even on the reference device, so no single slice can drop a frame.
 */
export const DEFAULT_CHUNK_SIZE = 200;

/** Split into fixed-size slices. Empty input ⇒ no slices (not one empty slice). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('chunk: size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Map over `items` a slice at a time, yielding between slices. Returns `null` if the run was
 * cancelled — callers MUST treat null as "throw this result away", not as "empty".
 *
 * Entries where `fn` returns `undefined` are dropped, so this doubles as a filter-map (the
 * contacts pipeline drops entries with no parseable number).
 */
export async function mapChunked<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => R | undefined,
  opts: ChunkedOptions = {},
): Promise<R[] | null> {
  const size = opts.size ?? DEFAULT_CHUNK_SIZE;
  const doYield = opts.yieldFn ?? yieldToEventLoop;
  const cancelled = opts.isCancelled;
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    if (cancelled?.()) return null;
    const end = Math.min(i + size, items.length);
    for (let j = i; j < end; j += 1) {
      // `items[j]` is in-bounds by construction; the cast avoids a per-item undefined check
      // in the hottest loop of the whole screen.
      const mapped = fn(items[j] as T, j);
      if (mapped !== undefined) out.push(mapped);
    }
    // Only yield when there is more to do — a trailing yield just delays the caller.
    if (end < items.length) await doYield();
  }
  if (cancelled?.()) return null;
  return out;
}
