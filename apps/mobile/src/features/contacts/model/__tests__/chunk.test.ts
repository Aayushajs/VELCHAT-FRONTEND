import { chunk, mapChunked, DEFAULT_CHUNK_SIZE } from '../chunk';

/** Synchronous stand-in for the real macrotask yield — tests assert slicing, never timing. */
const noYield = (): Promise<void> => Promise.resolve();

describe('chunk', () => {
  it('splits into fixed-size slices with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('returns no slices for an empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });
  it('returns one slice when the input is smaller than the size', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });
  it('rejects a non-positive size instead of looping forever', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('mapChunked', () => {
  it('maps every item, in order', async () => {
    const out = await mapChunked([1, 2, 3, 4, 5], n => n * 2, {
      size: 2,
      yieldFn: noYield,
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('passes the original index even across slice boundaries', async () => {
    const seen: number[] = [];
    await mapChunked(['a', 'b', 'c', 'd'], (_v, i) => seen.push(i), {
      size: 2,
      yieldFn: noYield,
    });
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('drops undefined results (filter-map)', async () => {
    const out = await mapChunked(
      [1, 2, 3, 4],
      n => (n % 2 === 0 ? n : undefined),
      { size: 3, yieldFn: noYield },
    );
    expect(out).toEqual([2, 4]);
  });

  it('yields between slices but never after the last one', async () => {
    let yields = 0;
    await mapChunked([1, 2, 3, 4, 5, 6], n => n, {
      size: 2,
      yieldFn: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect(yields).toBe(2); // 3 slices -> 2 gaps
  });

  it('does not yield at all for a single slice', async () => {
    let yields = 0;
    await mapChunked([1, 2], n => n, {
      size: 10,
      yieldFn: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect(yields).toBe(0);
  });

  it('returns null and stops working once cancelled', async () => {
    let processed = 0;
    const out = await mapChunked(
      [1, 2, 3, 4, 5, 6],
      n => {
        processed += 1;
        return n;
      },
      { size: 2, yieldFn: noYield, isCancelled: () => processed >= 2 },
    );
    expect(out).toBeNull();
    // The slice in flight finishes; nothing beyond it starts.
    expect(processed).toBe(2);
  });

  it('returns an empty array for an empty input, not null', async () => {
    expect(await mapChunked([], n => n, { yieldFn: noYield })).toEqual([]);
  });

  it('keeps a slice under a frame for a realistic book', async () => {
    // Guards the tuning constant itself: the point of chunking is that one slice is small.
    expect(DEFAULT_CHUNK_SIZE).toBeLessThanOrEqual(500);
    const big = Array.from({ length: 2000 }, (_v, i) => i);
    const out = await mapChunked(big, n => n, { yieldFn: noYield });
    expect(out).toHaveLength(2000);
  });

  it('really does hand control back to the event loop by default', async () => {
    // The default yield must be a MACROtask: a microtask would drain in the same turn and the
    // whole exercise would be a no-op. A timer scheduled mid-run must get to run.
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);
    await mapChunked([1, 2, 3, 4], n => n, { size: 1 });
    expect(timerRan).toBe(true);
  });
});
