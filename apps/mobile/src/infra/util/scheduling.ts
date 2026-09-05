/**
 * Cooperative scheduling primitives (§M0.4 "zero jank on the JS thread").
 *
 * Long synchronous passes — E.164 normalization, fingerprinting, and above all the OPRF
 * blinding in contact discovery — hold the JS thread for their entire duration, dropping every
 * frame inside them so the screen looks frozen. Slicing such a pass and awaiting a macrotask
 * between slices caps the longest single block at ONE slice.
 *
 * This lives in `infra` because BOTH the domain layer (the discovery use-case) and the feature
 * layer (`features/contacts/model/chunk`) need it, and the domain may not import features (§M3).
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
 * Run `fn` over `items` a slice at a time, awaiting a macrotask between slices, and collect the
 * results. Unlike a plain `map`, no single turn does more than `size` items' worth of work.
 *
 * `isCancelled` is checked between slices and makes the whole run return `null` — callers MUST
 * treat null as "throw this away", never as "empty".
 */
export async function mapYielding<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => R,
  opts: {
    size?: number;
    yieldFn?: () => Promise<void>;
    isCancelled?: () => boolean;
  } = {},
): Promise<R[] | null> {
  const size = opts.size ?? 100;
  const doYield = opts.yieldFn ?? yieldToEventLoop;
  const cancelled = opts.isCancelled;
  const out: R[] = new Array<R>(items.length);
  for (let i = 0; i < items.length; i += size) {
    if (cancelled?.()) return null;
    const end = Math.min(i + size, items.length);
    for (let j = i; j < end; j += 1) {
      out[j] = fn(items[j] as T, j);
    }
    // Only yield when there is more to do — a trailing yield just delays the caller.
    if (end < items.length) await doYield();
  }
  if (cancelled?.()) return null;
  return out;
}
