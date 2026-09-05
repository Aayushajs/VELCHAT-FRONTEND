/**
 * Incremental OPRF discovery cache (§G2). Pure, dependency-free, unit-tested.
 *
 * WHY: OPRF discovery is the dominant cost of New Chat, and today it is all-or-nothing — any
 * change to the address book re-blinds and re-unblinds EVERY number. Measured on a 2000-contact
 * book (2667 unique numbers) with desktop V8: blind ≈ 1.55 s, unblind ≈ 3.47 s, ~5 s total of
 * uninterrupted BigInt math, multiplied several-fold by Hermes on the reference device. Adding
 * one contact paid that bill again in full.
 *
 * This cache makes the cost proportional to what actually CHANGED. Each number remembers its
 * discovery outcome — an accountId, or `null` for "checked, not on VelChat" — so a re-run only
 * pays for numbers it has never resolved. On a settled book that is zero numbers, which is what
 * makes the screen instant rather than merely cached.
 *
 * Bounded by construction (§M1 "no unbounded caches"): entries expire, entries for numbers no
 * longer in the book are pruned, and a hard {@link DISCOVERY_CACHE_CAP} evicts oldest-first.
 *
 * The cache is keyed by the server's OPRF key VERSION: a key rotation invalidates every token,
 * so a version bump drops the whole cache rather than serving matches that can no longer be
 * reproduced.
 *
 * PRIVACY: entries are E.164 numbers → accountIds. Same sensitivity as the contacts snapshot
 * that sits beside it; it is account-scoped and wiped on sign-out. Never log a key or a value.
 */

/** One resolved number. `account: null` = checked and NOT on VelChat (a real, cacheable answer). */
export interface DiscoveryEntry {
  readonly account: string | null;
  /** When this outcome was learned (ms epoch) — drives expiry and eviction order. */
  readonly at: number;
}

export interface DiscoveryCache {
  /** Account this cache belongs to — a mismatch discards it (never serve another user's map). */
  readonly accountId: string | undefined;
  /** Server OPRF key version these outcomes were derived under. */
  readonly version: number;
  readonly entries: Readonly<Record<string, DiscoveryEntry>>;
}

/**
 * Hard ceiling on remembered numbers. Above a typical large address book (~2-3k numbers) with
 * headroom for churn, and small enough that the serialized cache stays well under a megabyte.
 */
export const DISCOVERY_CACHE_CAP = 6000;

/**
 * A positive match is stable — an accountId does not change under a number — so it is re-checked
 * only rarely, to catch a number that moved to a different account.
 */
export const POSITIVE_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * A negative is the one that goes stale: the contact may join VelChat later. The live path for
 * that is the server-side edge fan-out registered during discovery (a number flips the moment it
 * registers), so this only has to be the slow backstop — a week keeps the steady-state re-check
 * cost near zero without ever stranding a joiner.
 */
export const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60_000;

export function emptyDiscoveryCache(
  accountId: string | undefined,
  version: number,
): DiscoveryCache {
  return { accountId, version, entries: {} };
}

/** True while an outcome may still be served without re-asking the server. */
export function isFresh(entry: DiscoveryEntry, now: number): boolean {
  const ttl = entry.account === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  const age = now - entry.at;
  // A clock that jumped backwards would otherwise make every entry look infinitely fresh.
  return age >= 0 && age < ttl;
}

/**
 * The matches we can answer with immediately, with no network and no crypto. This is the value
 * of the cache: on a settled book it resolves the whole screen from local state.
 */
export function resolveKnown(
  cache: DiscoveryCache,
  numbers: readonly string[],
  now: number,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of numbers) {
    const e = cache.entries[n];
    if (e && e.account !== null && isFresh(e, now)) out.set(n, e.account);
  }
  return out;
}

/**
 * Which numbers still need a round-trip, capped at `budget`.
 *
 * Order is the caller's order (stable across runs, since it derives from the address book), and
 * anything resolved by a previous run is now fresh and skipped — so successive runs walk forward
 * through a book too large for one batch instead of re-attempting the same prefix. That is what
 * makes an over-budget book RESUMABLE rather than permanently truncated.
 */
export function selectPending(
  cache: DiscoveryCache,
  numbers: readonly string[],
  budget: number,
  now: number,
): string[] {
  if (budget <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of numbers) {
    if (seen.has(n)) continue;
    seen.add(n);
    const e = cache.entries[n];
    if (e && isFresh(e, now)) continue;
    out.push(n);
    if (out.length >= budget) break;
  }
  return out;
}

/** How many numbers still need work AFTER `budget` were taken — drives the resume decision. */
export function countPending(
  cache: DiscoveryCache,
  numbers: readonly string[],
  now: number,
): number {
  let n = 0;
  const seen = new Set<string>();
  for (const num of numbers) {
    if (seen.has(num)) continue;
    seen.add(num);
    const e = cache.entries[num];
    if (!e || !isFresh(e, now)) n += 1;
  }
  return n;
}

/**
 * Fold one discovery round-trip into the cache. EVERY attempted number is recorded — a number
 * that came back unmatched is a negative, not a gap, and remembering that is what stops the next
 * run from re-asking. Only call this when the round-trip actually succeeded; a failed call must
 * leave the cache untouched so the numbers stay pending.
 */
export function mergeDiscovered(
  cache: DiscoveryCache,
  attempted: readonly string[],
  matches: ReadonlyMap<string, string>,
  now: number,
): DiscoveryCache {
  const entries: Record<string, DiscoveryEntry> = { ...cache.entries };
  for (const n of attempted) {
    entries[n] = { account: matches.get(n) ?? null, at: now };
  }
  return { accountId: cache.accountId, version: cache.version, entries };
}

/**
 * Bound the cache (§M1): drop expired entries and entries for numbers no longer in the address
 * book, then evict oldest-first down to `cap`. `keep` empty means "book unknown" (e.g. the read
 * failed) — in that case nothing is pruned for absence, only for age, so a transient read failure
 * cannot throw away a whole warm cache.
 */
export function pruneCache(
  cache: DiscoveryCache,
  keep: ReadonlySet<string>,
  now: number,
  cap: number = DISCOVERY_CACHE_CAP,
): DiscoveryCache {
  const surviving: [string, DiscoveryEntry][] = [];
  for (const [n, e] of Object.entries(cache.entries)) {
    if (!isFresh(e, now)) continue;
    if (keep.size > 0 && !keep.has(n)) continue;
    surviving.push([n, e]);
  }
  if (surviving.length > cap) {
    surviving.sort((a, b) => b[1].at - a[1].at); // newest first, then keep the head
    surviving.length = cap;
  }
  const entries: Record<string, DiscoveryEntry> = {};
  for (const [n, e] of surviving) entries[n] = e;
  return { accountId: cache.accountId, version: cache.version, entries };
}

/**
 * Parse a persisted cache, discarding it on anything unexpected: a different account, a rotated
 * OPRF key version, or a malformed blob. Discarding is always safe — it costs one re-discovery,
 * whereas trusting a stale shape would surface wrong matches.
 */
export function parseDiscoveryCache(
  raw: string | undefined,
  accountId: string | undefined,
  version: number,
): DiscoveryCache {
  if (!raw) return emptyDiscoveryCache(accountId, version);
  try {
    const parsed = JSON.parse(raw) as Partial<DiscoveryCache>;
    if (
      parsed.accountId !== accountId ||
      parsed.version !== version ||
      typeof parsed.entries !== 'object' ||
      parsed.entries === null
    ) {
      return emptyDiscoveryCache(accountId, version);
    }
    return { accountId, version, entries: parsed.entries };
  } catch {
    return emptyDiscoveryCache(accountId, version);
  }
}
