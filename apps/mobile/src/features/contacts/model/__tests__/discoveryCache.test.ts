import {
  DISCOVERY_CACHE_CAP,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  countPending,
  emptyDiscoveryCache,
  isFresh,
  mergeDiscovered,
  parseDiscoveryCache,
  pruneCache,
  resolveKnown,
  selectPending,
  type DiscoveryCache,
} from '../discoveryCache';

const NOW = 1_700_000_000_000;
const ACC = 'me';

const cacheOf = (
  entries: Record<string, { account: string | null; at: number }>,
  version = 1,
): DiscoveryCache => ({ accountId: ACC, version, entries });

describe('isFresh', () => {
  it('keeps a positive for far longer than a negative', () => {
    const at = NOW - NEGATIVE_TTL_MS - 1;
    expect(isFresh({ account: 'a1', at }, NOW)).toBe(true);
    expect(isFresh({ account: null, at }, NOW)).toBe(false);
  });
  it('expires a positive past its own TTL', () => {
    expect(isFresh({ account: 'a1', at: NOW - POSITIVE_TTL_MS - 1 }, NOW)).toBe(
      false,
    );
  });
  it('treats a backwards clock jump as stale rather than immortal', () => {
    expect(isFresh({ account: 'a1', at: NOW + 60_000 }, NOW)).toBe(false);
  });
});

describe('resolveKnown', () => {
  it('answers positives with no network', () => {
    const c = cacheOf({
      '+911': { account: 'a1', at: NOW },
      '+912': { account: null, at: NOW },
    });
    const known = resolveKnown(c, ['+911', '+912', '+913'], NOW);
    expect([...known]).toEqual([['+911', 'a1']]);
  });
  it('ignores an expired positive', () => {
    const c = cacheOf({
      '+911': { account: 'a1', at: NOW - POSITIVE_TTL_MS - 1 },
    });
    expect(resolveKnown(c, ['+911'], NOW).size).toBe(0);
  });
});

describe('selectPending — the incremental core', () => {
  it('asks only for numbers it has never resolved', () => {
    const c = cacheOf({
      '+911': { account: 'a1', at: NOW },
      '+912': { account: null, at: NOW },
    });
    expect(selectPending(c, ['+911', '+912', '+913'], 100, NOW)).toEqual([
      '+913',
    ]);
  });

  it('asks for nothing at all when the book is fully resolved', () => {
    const c = cacheOf({
      '+911': { account: 'a1', at: NOW },
      '+912': { account: null, at: NOW },
    });
    expect(selectPending(c, ['+911', '+912'], 100, NOW)).toEqual([]);
  });

  it('re-asks once a negative has expired (a contact may have joined)', () => {
    const c = cacheOf({
      '+912': { account: null, at: NOW - NEGATIVE_TTL_MS - 1 },
    });
    expect(selectPending(c, ['+912'], 100, NOW)).toEqual(['+912']);
  });

  it('de-duplicates a number saved under two contacts', () => {
    const c = emptyDiscoveryCache(ACC, 1);
    expect(selectPending(c, ['+911', '+911', '+912'], 100, NOW)).toEqual([
      '+911',
      '+912',
    ]);
  });

  it('honours the budget', () => {
    const c = emptyDiscoveryCache(ACC, 1);
    const numbers = Array.from({ length: 50 }, (_v, i) => `+9${i}`);
    expect(selectPending(c, numbers, 10, NOW)).toHaveLength(10);
  });

  it('resumes where the previous run stopped instead of retrying the same prefix', () => {
    // This is the fix for the old silent truncation: an over-budget book used to lose the tail
    // forever, so real VelChat users sat in the Invite section permanently.
    const numbers = Array.from({ length: 25 }, (_v, i) => `+9${i}`);
    let cache = emptyDiscoveryCache(ACC, 1);

    const run1 = selectPending(cache, numbers, 10, NOW);
    expect(run1).toEqual(numbers.slice(0, 10));
    cache = mergeDiscovered(cache, run1, new Map(), NOW);

    const run2 = selectPending(cache, numbers, 10, NOW);
    expect(run2).toEqual(numbers.slice(10, 20));
    cache = mergeDiscovered(cache, run2, new Map(), NOW);

    const run3 = selectPending(cache, numbers, 10, NOW);
    expect(run3).toEqual(numbers.slice(20, 25));
    cache = mergeDiscovered(cache, run3, new Map(), NOW);

    expect(selectPending(cache, numbers, 10, NOW)).toEqual([]);
    expect(countPending(cache, numbers, NOW)).toBe(0);
  });

  it('returns nothing for a non-positive budget', () => {
    expect(
      selectPending(emptyDiscoveryCache(ACC, 1), ['+911'], 0, NOW),
    ).toEqual([]);
  });
});

describe('countPending', () => {
  it('counts distinct unresolved numbers only', () => {
    const c = cacheOf({ '+911': { account: 'a1', at: NOW } });
    expect(countPending(c, ['+911', '+912', '+912', '+913'], NOW)).toBe(2);
  });
});

describe('mergeDiscovered', () => {
  it('records an unmatched number as a negative, not a gap', () => {
    const c = mergeDiscovered(
      emptyDiscoveryCache(ACC, 1),
      ['+911', '+912'],
      new Map([['+911', 'a1']]),
      NOW,
    );
    expect(c.entries['+911']).toEqual({ account: 'a1', at: NOW });
    expect(c.entries['+912']).toEqual({ account: null, at: NOW });
  });

  it('does not mutate the input cache', () => {
    const before = emptyDiscoveryCache(ACC, 1);
    mergeDiscovered(before, ['+911'], new Map(), NOW);
    expect(before.entries).toEqual({});
  });

  it('upgrades a stale negative to a fresh positive', () => {
    const c = mergeDiscovered(
      cacheOf({ '+911': { account: null, at: NOW - NEGATIVE_TTL_MS - 1 } }),
      ['+911'],
      new Map([['+911', 'a9']]),
      NOW,
    );
    expect(c.entries['+911']).toEqual({ account: 'a9', at: NOW });
  });
});

describe('pruneCache — bounded, per §M1', () => {
  it('drops entries for numbers no longer in the book', () => {
    const c = pruneCache(
      cacheOf({
        '+911': { account: 'a1', at: NOW },
        '+999': { account: 'a2', at: NOW },
      }),
      new Set(['+911']),
      NOW,
    );
    expect(Object.keys(c.entries)).toEqual(['+911']);
  });

  it('drops expired entries', () => {
    const c = pruneCache(
      cacheOf({ '+911': { account: null, at: NOW - NEGATIVE_TTL_MS - 1 } }),
      new Set(['+911']),
      NOW,
    );
    expect(c.entries).toEqual({});
  });

  it('evicts oldest-first down to the cap', () => {
    const entries: Record<string, { account: string | null; at: number }> = {};
    for (let i = 0; i < 10; i += 1) {
      entries[`+9${i}`] = { account: 'a', at: NOW - i * 1000 };
    }
    const c = pruneCache(
      cacheOf(entries),
      new Set(Object.keys(entries)),
      NOW,
      3,
    );
    expect(Object.keys(c.entries).sort()).toEqual(['+90', '+91', '+92']);
  });

  it('never grows past the hard cap', () => {
    const entries: Record<string, { account: string | null; at: number }> = {};
    for (let i = 0; i < DISCOVERY_CACHE_CAP + 500; i += 1) {
      entries[`+9${i}`] = { account: 'a', at: NOW - i };
    }
    const c = pruneCache(cacheOf(entries), new Set(Object.keys(entries)), NOW);
    expect(Object.keys(c.entries)).toHaveLength(DISCOVERY_CACHE_CAP);
  });

  it('prunes only for age when the book is unknown (a failed read keeps the cache)', () => {
    const c = pruneCache(
      cacheOf({ '+911': { account: 'a1', at: NOW } }),
      new Set(),
      NOW,
    );
    expect(Object.keys(c.entries)).toEqual(['+911']);
  });
});

describe('parseDiscoveryCache', () => {
  it('round-trips', () => {
    const c = cacheOf({ '+911': { account: 'a1', at: NOW } });
    expect(parseDiscoveryCache(JSON.stringify(c), ACC, 1)).toEqual(c);
  });
  it('discards another account cache', () => {
    const c = cacheOf({ '+911': { account: 'a1', at: NOW } });
    expect(
      parseDiscoveryCache(JSON.stringify(c), 'someone-else', 1).entries,
    ).toEqual({});
  });
  it('discards on an OPRF key rotation', () => {
    const c = cacheOf({ '+911': { account: 'a1', at: NOW } }, 1);
    expect(parseDiscoveryCache(JSON.stringify(c), ACC, 2).entries).toEqual({});
  });
  it('survives a malformed blob', () => {
    expect(parseDiscoveryCache('{not json', ACC, 1).entries).toEqual({});
    expect(parseDiscoveryCache(undefined, ACC, 1).entries).toEqual({});
    expect(
      parseDiscoveryCache(
        JSON.stringify({ accountId: ACC, version: 1 }),
        ACC,
        1,
      ).entries,
    ).toEqual({});
  });
});
