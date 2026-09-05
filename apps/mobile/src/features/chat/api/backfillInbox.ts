/**
 * Inbox restore (§M0/§L6) — bring this account's chat list back after a fresh install, a
 * re-login, or a logout wipe.
 *
 * Three properties decide whether the list feels instant or broken, and the previous version had
 * none of them:
 *
 *  1. **Conversations land before their messages.** One inbox call gives every conversation and
 *     its members, so all of that is written in ONE batch first. The rows exist immediately.
 *  2. **Bounded concurrency, not a sequential walk.** It used to `await` a profile fetch and a
 *     message fetch per conversation, one after another — twenty chats meant forty serialised
 *     round-trips, so on a real connection the list dribbled in over ten seconds in a seemingly
 *     random order. The same work now runs a few at a time.
 *  3. **Incremental.** It refetched every conversation's history from seq 0 on EVERY launch, even
 *     though the local database already held it. Now it asks only for what comes after the local
 *     cursor, so a warm start costs almost nothing.
 *
 * Identity is resolved here too, once, and written onto the row: the inbox response already
 * carries the member ids, so a DM's peer is free, and its photo is fetched once instead of by
 * every list row on every recycle. Rendering the list then touches no network at all.
 *
 * Best-effort + idempotent: any per-conversation failure is skipped; never throws.
 */
import {
  fetchInbox,
  upsertConversation,
  getAccountId,
  fetchMessagesAfter,
  applyServerMessages,
  maxSeqForConversation,
  type InboxConversation,
} from '../../../infra';
import { getProfile, getMediaUrl } from '../../user';

/**
 * How many conversations are worked on at once. Enough to hide per-request latency, low enough
 * that a fifty-chat account doesn't fire a burst the edge rate-limiter reads as abuse.
 */
const CONCURRENCY = 6;

/** Run `task` over `items` with a fixed number of workers, preserving input order of work. */
async function mapBounded<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      try {
        await task(item);
      } catch {
        // Best-effort per conversation: one failure must not abandon the rest of the inbox.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/** The other member of a DM — the whole reason a DM has a name and a face. */
function peerOf(c: InboxConversation, me: string): string | undefined {
  if (c.type !== 'dm') return undefined;
  return c.memberIds.find(id => id !== me) ?? undefined;
}

export async function backfillInbox(): Promise<void> {
  const me = getAccountId();
  if (!me) return;

  let rows: InboxConversation[];
  try {
    rows = await fetchInbox(me);
  } catch {
    return; // offline / backend down — whatever the local DB holds still renders
  }
  if (rows.length === 0) return;

  // Phase 1 — write every conversation row up front, with the peer id we already have. No network.
  // The list can render names and coloured initials from this alone.
  await Promise.all(
    rows.map(async c => {
      const peerId = peerOf(c, me);
      const patch: Parameters<typeof upsertConversation>[1] = { type: c.type };
      if (c.name) patch.name = c.name;
      if (peerId) patch.peerId = peerId;
      try {
        await upsertConversation(c.conversationId, patch);
      } catch {
        // a row that can't be written simply won't show; the next sync retries it
      }
    }),
  );

  // Phase 2 — fill in history and identity, a few conversations at a time.
  await mapBounded(rows, CONCURRENCY, async c => {
    const peerId = peerOf(c, me);

    // Only ask for what we don't already hold. On a warm start this is usually an empty response.
    const cursor = await maxSeqForConversation(c.conversationId).catch(() => 0);
    const msgs = await fetchMessagesAfter(c.conversationId, cursor).catch(
      () => [],
    );
    if (msgs.length > 0) await applyServerMessages(msgs);

    // A DM carries no name of its own — it is named, and pictured, by the other person.
    if (!peerId) return;
    const profile = await getProfile(peerId).catch(() => null);
    if (!profile) return;
    const patch: Parameters<typeof upsertConversation>[1] = {};
    const name = profile.displayName?.trim();
    if (name && !c.name) patch.name = name;
    if (profile.avatarMediaId) {
      const media = await getMediaUrl(profile.avatarMediaId).catch(() => null);
      if (media?.url) patch.peerAvatarUrl = media.url;
    }
    if (Object.keys(patch).length > 0) {
      await upsertConversation(c.conversationId, patch).catch(() => undefined);
    }
  });
}
