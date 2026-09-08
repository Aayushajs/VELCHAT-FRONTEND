/**
 * Keep a DM's cached name + photo honest (§M0 rule 2: fast first, correct always).
 *
 * The chat list renders a peer's photo from the conversation row so it appears instantly with no
 * network. The obvious risk of any such cache is staleness — the peer changes their picture and
 * everyone else keeps seeing the old one forever. So the row is revalidated in the background:
 * the UI shows what it has immediately (0 ms), and if the server disagrees the row is updated and
 * the list re-renders on its own, because the list observes the database.
 *
 * Revalidation is deliberately cheap and rare: once per TTL per conversation, only for a chat the
 * user actually opens, never during scrolling, and never blocking anything the user is waiting on.
 */
import {
  upsertConversation,
  peerIdentityAgeMs,
  conversationIdsForPeer,
  type ConversationPatch,
} from '../../../infra';
import { subscribeProfileChanged } from '../../../core';
import { getProfile, getMediaUrl } from '../../user';

/**
 * How long a cached name/photo is trusted. The cost of being wrong is a peer's new picture taking
 * up to this long to appear, and the cost of being aggressive is one profile request per opened
 * chat — so this is bounded by chats the user actually opens, never by list size or scrolling.
 */
const IDENTITY_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Conversations already revalidated this run — one attempt per app session per conversation. */
const attempted = new Set<string>();

/** Logout: identities belong to the session that resolved them. */
export function clearPeerIdentityAttempts(): void {
  attempted.clear();
}

/**
 * Refresh a DM's peer name/photo if what we hold is older than the TTL. Fire-and-forget: callers
 * must never await this on a render path.
 */
export async function refreshPeerIdentity(
  conversationId: string,
  peerId: string | undefined,
): Promise<void> {
  if (!peerId || attempted.has(conversationId)) return;
  const age = await peerIdentityAgeMs(conversationId).catch(() => null);
  if (age !== null && age < IDENTITY_TTL_MS) return;
  attempted.add(conversationId);

  const profile = await getProfile(peerId).catch(() => null);
  if (!profile) return;
  const patch: ConversationPatch = {};
  const name = profile.displayName?.trim();
  if (name) patch.name = name;
  if (profile.avatarMediaId) {
    const media = await getMediaUrl(profile.avatarMediaId).catch(() => null);
    if (media?.url) patch.peerAvatarUrl = media.url;
  }
  if (Object.keys(patch).length > 0) {
    await upsertConversation(conversationId, patch).catch(() => undefined);
  }
}

/**
 * Resolve this account's current name/photo and write it into every conversation that shows it.
 *
 * The TTL above is the right policy for "a peer might have changed something" — it costs one
 * request per opened chat. It is the WRONG policy for "we KNOW this account just changed": the
 * user watches their new picture not appear in the chat list for up to an hour, or until the app
 * is killed. So a change is pushed, and the TTL stays as the background safety net.
 */
async function refreshPeerIdentityFor(accountId: string): Promise<void> {
  // Yield once so every SYNCHRONOUS listener on the profile bus has run — in particular the one
  // that drops this account from the profile response cache. Fetching before that would re-read
  // the very copy we are trying to replace, and the row would be rewritten with the old photo.
  await Promise.resolve();

  const ids = await conversationIdsForPeer(accountId).catch(() => []);
  if (ids.length === 0) return;

  const profile = await getProfile(accountId).catch(() => null);
  if (!profile) return;
  const patch: ConversationPatch = {};
  const name = profile.displayName?.trim();
  if (name) patch.name = name;
  if (profile.avatarMediaId) {
    const media = await getMediaUrl(profile.avatarMediaId).catch(() => null);
    if (media?.url) patch.peerAvatarUrl = media.url;
  }
  if (Object.keys(patch).length === 0) return;

  for (const id of ids) {
    // Re-allow the TTL path too: this conversation has been refreshed, and a later genuine
    // staleness check should not be blocked by the once-per-session guard.
    attempted.delete(id);
    await upsertConversation(id, patch).catch(() => undefined);
  }
}

// A profile change — ours or a peer's — lands in the chat list without waiting out the TTL.
subscribeProfileChanged(accountId => {
  void refreshPeerIdentityFor(accountId);
});
