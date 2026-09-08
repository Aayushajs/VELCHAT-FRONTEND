/**
 * A VelChat user's profile photo (DP) for lists/headers — cached like WhatsApp: persisted to
 * MMKV per account, shown INSTANTLY on every render/restart with no network, and refreshed only
 * when the cached signed URL is about to expire (or the avatar actually changed).
 *
 * RECYCLE-SAFE (critical for FlashList): the hook NEVER holds the resolved URL in state — it
 * derives it from the in-memory cache keyed by the CURRENT accountId on every render. So when a
 * row is recycled for a different contact, it can never flash the previous contact's photo. A
 * bump counter just forces a re-read after an async resolve, and ONLY when the resolved URL
 * actually differs from what this row last rendered — the effect re-runs on every recycle, so
 * an unconditional bump doubled the render cost of the whole visible window per scroll tick.
 *
 * Why not cache the URL forever: media URLs are short-lived signed links (~10 min), so we store
 * url + mediaId + timestamp; fresh → serve from cache (zero API), stale → render the last known
 * URL IMMEDIATELY and refresh behind it (one cached profile read + one URL resolve). "No avatar"
 * is cached too, so we don't re-ask. A stale URL is served rather than withheld because its
 * bytes are already in the native image cache, so it still renders with the API unreachable;
 * only a contact we have never resolved falls back to a coloured initial.
 *
 * Both caches are BOUNDED and purgeable (§M0 rule 7): a per-account signed URL is another
 * account's data, so `clearContactAvatarCache()` must run on logout.
 */
import { useEffect, useRef, useState } from 'react';
import { Image } from 'react-native';
import { kv } from '../../../infra';
import { getProfile, getMediaUrl } from '../api/userApi';
import { subscribeProfileChanged } from '../../../core';

const URL_TTL_MS = 9 * 60_000; // refresh just before the ~10-min signed-URL expiry
const MEM_CAP = 200; // live URLs held in RAM — far more than any visible window
const DISK_CAP = 300; // persisted `avatar.<id>` entries; the index below bounds them
const INDEX_KEY = 'avatar.index.v1'; // MRU-first list of persisted ids (dynamic keys are
// otherwise un-enumerable through the kv wrapper, so neither eviction nor logout could find them)

const mem = new Map<string, string>(); // accountId → live URL (the render source of truth)

// In-flight resolves started before a logout must not repopulate a cleared cache.
let generation = 0;

interface Cached {
  mediaId: string | null;
  url: string | null;
  at: number;
}

function cacheKey(id: string): string {
  return `avatar.${id}`;
}

/** Insert as most-recently-used (Map keeps insertion order) and evict the oldest over cap. */
function memSet(id: string, url: string): void {
  mem.delete(id);
  mem.set(id, url);
  while (mem.size > MEM_CAP) {
    const oldest: string | undefined = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

function readIndex(): string[] {
  try {
    const raw = kv.getString(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Move `id` to the front of the persisted index, dropping (and deleting) anything over cap. */
function indexTouch(id: string): void {
  try {
    const ids = readIndex().filter(x => x !== id);
    ids.unshift(id);
    for (const evicted of ids.splice(DISK_CAP)) kv.delete(cacheKey(evicted));
    kv.set(INDEX_KEY, JSON.stringify(ids));
  } catch {
    // best-effort cache bookkeeping
  }
}

function read(id: string): Cached | null {
  try {
    const raw = kv.getString(cacheKey(id));
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

function write(id: string, c: Cached): void {
  try {
    kv.set(cacheKey(id), JSON.stringify(c));
    indexTouch(id);
  } catch {
    // best-effort cache
  }
  if (c.url) {
    memSet(id, c.url);
    // Pull the BYTES into the native image cache while the backend is reachable. The URL is a
    // ~10-minute signed link that cannot be re-signed once the API is unreachable, but the
    // decoder can still serve this exact URL from its own disk cache — which is what keeps
    // photos on screen when the backend is down.
    Image.prefetch(c.url).catch(() => undefined);
  } else {
    mem.delete(id); // "no avatar" → never leave a stale URL in the render cache
  }
}

/**
 * Drop every cached avatar, in RAM and on disk. MUST be called on logout: the cached signed
 * URLs and the "who has no avatar" knowledge belong to the account that resolved them.
 */
export function clearContactAvatarCache(): void {
  generation += 1;
  mem.clear();
  try {
    for (const id of readIndex()) kv.delete(cacheKey(id));
    kv.delete(INDEX_KEY);
  } catch {
    // best-effort purge
  }
}

/**
 * Mounted instances, so an invalidation can refresh what is ALREADY on screen.
 *
 * Clearing the caches alone is not enough: this hook returns from the render cache, so a row that
 * is already displaying the old photo would keep displaying it until something else happened to
 * re-render it. That is the difference between "the cache is correct now" and "the user can see
 * the new photo now".
 */
const mounted = new Map<string, Set<() => void>>();

function watch(accountId: string, refresh: () => void): () => void {
  const set = mounted.get(accountId) ?? new Set<() => void>();
  set.add(refresh);
  mounted.set(accountId, set);
  return () => {
    set.delete(refresh);
    if (set.size === 0) mounted.delete(accountId);
  };
}

/**
 * Forget one account's resolved photo, in RAM and on disk, and re-resolve it wherever it is
 * currently rendered. Driven by the profile-change bus, so a photo change — ours or a peer's —
 * lands everywhere at once instead of waiting out a TTL.
 */
export function invalidateContactAvatar(accountId: string): void {
  if (!accountId) return;
  mem.delete(accountId);
  try {
    kv.delete(cacheKey(accountId));
  } catch {
    // best-effort: the RAM drop above is what the next render actually reads
  }
  for (const refresh of [...(mounted.get(accountId) ?? [])]) refresh();
}

subscribeProfileChanged(invalidateContactAvatar);

export function useContactAvatar(
  accountId: string | undefined,
): string | undefined {
  const [, bump] = useState(0);
  // What this instance last RETURNED. Written during render on purpose: it mirrors the value
  // the caller is showing, which is the only thing the effect may compare against to decide
  // whether a re-render is actually needed.
  const rendered = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!accountId) return undefined;
    let alive = true;
    const gen = generation;
    // Re-read on invalidation. `rendered` still holds the OLD url, so `settle()` sees a real
    // difference and re-renders; a missing cache entry then drives the refresh below.
    const unwatch = watch(accountId, () => {
      if (alive && gen === generation) bump(n => (n + 1) % 1_000_000);
    });
    const settle = (): void => {
      if (!alive || gen !== generation) return;
      const next = mem.get(accountId);
      if (next !== rendered.current) bump(n => (n + 1) % 1_000_000);
    };
    const cached = read(accountId);
    const fresh = cached && Date.now() - cached.at < URL_TTL_MS;

    // Seed the render cache from whatever we already know FIRST, fresh or not.
    //
    // This used to happen only on the `fresh` branch, so a STALE entry rendered nothing while
    // the refresh was in flight — and if that refresh failed (backend down, offline, expired
    // signature) it rendered nothing at all and the row fell back to a coloured initial. The
    // last known URL is still the best answer available: its bytes are in the native image
    // cache (primed in `write`), so it keeps displaying even with the API unreachable.
    if (cached) {
      if (cached.url) memSet(accountId, cached.url);
      else mem.delete(accountId);
      settle();
    }

    if (fresh) {
      return () => {
        alive = false;
        unwatch();
      };
    }

    // Stale/missing → refresh: profile (cached upstream) → mediaId → signed URL. Rare.
    void (async () => {
      try {
        const profile = await getProfile(accountId);
        const mediaId = profile.avatarMediaId ?? null;
        if (gen !== generation) return; // logged out mid-flight — do not repopulate
        if (!mediaId) {
          write(accountId, { mediaId: null, url: null, at: Date.now() });
        } else {
          const { url } = await getMediaUrl(mediaId);
          if (gen !== generation) return;
          write(accountId, { mediaId, url, at: Date.now() });
        }
        settle();
      } catch {
        // keep whatever we already have (cached url, or the initial)
      }
    })();
    return () => {
      alive = false;
      unwatch();
    };
  }, [accountId]);

  // ALWAYS read for the CURRENT accountId — never stale state from a recycled row.
  const url = accountId ? mem.get(accountId) : undefined;
  rendered.current = url;
  return url;
}
