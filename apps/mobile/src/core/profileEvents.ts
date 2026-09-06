/**
 * "This account's profile changed" — a one-line announcement, many listeners (§M0 rule 7).
 *
 * A profile photo is served from several independent caches: the profile response cache, the
 * resolved-avatar cache (RAM + MMKV, holding a signed URL), and the peer photo denormalised onto
 * each conversation row so the chat list can render without network. Each exists for a good
 * reason — together they are why the list is instant — but the WRITE path never told any of them
 * that the underlying profile had moved. So a successful photo change kept showing the old
 * picture everywhere until each cache's own TTL expired, or the process was killed. "It only
 * updates after I close and reopen the app" is that, exactly.
 *
 * A bus rather than direct calls, because the writer must not have to know the full set of
 * caches — it grows (search results, group member lists), and the last one added is the one
 * somebody forgets to invalidate.
 */
import { log } from './logger';

type ProfileListener = (accountId: string) => void;

const listeners = new Set<ProfileListener>();

/**
 * Observe profile changes. Returns an unsubscribe (§M7: every long-lived listener is owned and
 * disposable).
 */
export function subscribeProfileChanged(fn: ProfileListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Announce that `accountId`'s profile changed — after a save of our own, or an inbound event
 * about someone else's.
 *
 * Iterates a COPY so a listener that unsubscribes mid-dispatch cannot skip the next one, and
 * isolates failures: these callbacks purge caches, and the first one to throw must not leave the
 * rest still serving the stale photo.
 */
export function publishProfileChanged(accountId: string): void {
  if (!accountId) return; // an empty id would mean "everyone", which no caller means
  for (const fn of [...listeners]) {
    try {
      fn(accountId);
    } catch (e) {
      log.warn('profile-change listener failed', { reason: String(e) });
    }
  }
}
