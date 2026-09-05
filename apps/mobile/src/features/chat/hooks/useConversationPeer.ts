/**
 * Resolve a DM's peer account id (the other member) so the chat list + header can show that
 * user's profile photo. The conversation row stores no peer id, so we look up the member list
 * once and cache it in-module (keyed by conversationId) — subsequent renders/rows are free.
 *
 * RECYCLE-SAFE: like useContactAvatar, the value is derived from the cache for the CURRENT
 * conversationId on every render (never held in stale state), so a recycled FlashList row can
 * never show the previous conversation's peer/photo. A bump forces a re-read after resolve.
 * No-op for a missing id (pass undefined for groups/self). Best-effort; failure → no peer.
 *
 * The cache is BOUNDED and purgeable (§M0 rule 7): a conversation→peer mapping is one account's
 * data, so `clearConversationPeerCache()` must run on logout.
 */
import { useEffect, useState } from 'react';
import { getConversationMembers, getAccountId } from '../../../infra';

const CACHE_CAP = 200; // far more than any visible window; bounds a long browsing session
const peerCache = new Map<string, string>();
const resolving = new Set<string>(); // in-flight guard (one members fetch per conversation)

// In-flight resolves started before a logout must not repopulate a cleared cache.
let generation = 0;

/** Insert as most-recently-used (Map keeps insertion order) and evict the oldest over cap. */
function cachePeer(conversationId: string, accountId: string): void {
  peerCache.delete(conversationId);
  peerCache.set(conversationId, accountId);
  while (peerCache.size > CACHE_CAP) {
    const oldest: string | undefined = peerCache.keys().next().value;
    if (oldest === undefined) break;
    peerCache.delete(oldest);
  }
}

/** Drop every resolved peer. MUST be called on logout — these ids belong to that session. */
export function clearConversationPeerCache(): void {
  generation += 1;
  peerCache.clear();
  resolving.clear();
}

export function useConversationPeer(
  conversationId: string | undefined,
): string | undefined {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!conversationId) return undefined;
    const hit = peerCache.get(conversationId);
    if (hit !== undefined) {
      cachePeer(conversationId, hit); // mark used so eviction drops the coldest, not this
      return undefined;
    }
    if (resolving.has(conversationId)) return undefined;
    let alive = true;
    const gen = generation;
    resolving.add(conversationId);
    void (async () => {
      try {
        const members = await getConversationMembers(conversationId);
        const me = getAccountId();
        const other = members.find(m => m !== me) ?? members[0];
        if (other && gen === generation) cachePeer(conversationId, other);
      } catch {
        // best-effort: no peer → the row shows a coloured initial
      } finally {
        resolving.delete(conversationId);
        if (alive && gen === generation) bump(n => (n + 1) % 1_000_000);
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversationId]);

  // ALWAYS read for the CURRENT conversationId — never stale state from a recycled row.
  return conversationId ? peerCache.get(conversationId) : undefined;
}
