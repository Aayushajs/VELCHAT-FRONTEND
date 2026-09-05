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
  type ConversationPatch,
} from '../../../infra';
import { getProfile, getMediaUrl } from '../../user';

/**
 * How long a cached name/photo is trusted. Long enough that opening chats all day costs nothing;
 * short enough that a changed picture shows up the same session.
 */
const IDENTITY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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
