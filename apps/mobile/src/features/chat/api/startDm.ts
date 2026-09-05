/**
 * Start (or resume) a DM with a peer (§F2, §M0). The backend has NO inbox endpoint, so the
 * flow is: derive the DM's (deterministic) id → upsert a LOCAL conversation row → let the chat
 * list observe the DB → converge the server row in the background. The chat list observes the
 * local DB, so the DM appears the instant the upsert lands.
 *
 * OFFLINE-FIRST (§M0 rule 2 — the UI never waits on the network on the render path):
 * this used to `await createDm()` and return only after the round-trip, so selecting a contact
 * in New Chat did nothing at all when offline — and nothing when the request merely failed
 * (cold backend, 5xx, timeout) either, because the caller's `catch` just showed an error and
 * never navigated. The id is a pure function of the member pair, so none of that wait was ever
 * needed to know WHERE the chat lives.
 *
 * The server call is still made, because it does two things local state cannot: it inserts the
 * conversation + membership rows, and it emits `conversation.created`, which seeds the
 * realtime-gateway's membership projection. Message fan-out returns early for a conversation
 * with no known members, so a DM that was never created server-side would deliver messages that
 * never reach the peer in real time. `ensureDmOnServer` therefore retries.
 *
 * Layer note: this is feature code (features/chat/api), so it may reuse the user directory
 * (features/user barrel, feature→feature) and infra — never the other way round (§M3).
 */
import { log } from '../../../core';
import {
  createDm,
  dmConversationId,
  upsertConversation,
  getAccountId,
} from '../../../infra';
import { getProfile } from '../../user';

/**
 * Conversations whose server-side row we have already confirmed in this session, so re-opening
 * a chat doesn't re-POST on every visit. Bounded (§M0 rule 7) — it only ever holds ids the user
 * actually opened, and it is cleared on logout with the rest of the chat caches.
 */
const confirmedOnServer = new Set<string>();
const CONFIRMED_CAP = 500;

/** Logout: the next account must not inherit this one's "already created" knowledge. */
export function clearStartDmCache(): void {
  confirmedOnServer.clear();
}

/**
 * Make sure the DM exists server-side (and its membership projection is seeded). Idempotent on
 * the backend, so a duplicate call is free. Best-effort: a failure leaves the id unconfirmed so
 * the next open — or the first send, which goes through the outbox and retries anyway — tries
 * again. Never throws; callers treat this as background convergence.
 */
export async function ensureDmOnServer(
  me: string,
  peer: string,
): Promise<void> {
  const expected = dmConversationId(me, peer);
  if (confirmedOnServer.has(expected)) return;
  try {
    const { conversationId } = await createDm(me, peer);
    if (conversationId !== expected) {
      // The server's derivation is the authority. If it ever diverges from our port, keep BOTH
      // rows rather than silently writing to a thread the server doesn't use — and say so
      // loudly, because it means `dmId.ts` needs re-syncing with the backend.
      log.warn('dm id mismatch: local derivation differs from server', {
        expected,
        conversationId,
      });
      await upsertConversation(conversationId, { type: 'dm' });
    }
    if (confirmedOnServer.size >= CONFIRMED_CAP) confirmedOnServer.clear();
    confirmedOnServer.add(expected);
  } catch (e) {
    log.warn('createDm failed — will retry on next open/send', {
      reason: String(e),
    });
  }
}

/**
 * Create-or-resolve a DM with `peerAccountId` and return the (deterministic) conversationId.
 *
 * Returns as soon as the LOCAL row exists — no network on this path — so the caller can navigate
 * straight to the chat, online or offline, whether or not the two have ever spoken before.
 *
 * When `preferredName` is given (the user's own saved contact name, the WhatsApp way) it names
 * the chat directly — no directory round-trip. Otherwise the name is resolved in the background
 * and the row is renamed when it arrives; the chat list observes the DB, so the label updates in
 * place. Throws only when there is no signed-in account or the peer id is blank.
 */
export async function startDm(
  peerAccountId: string,
  preferredName?: string,
): Promise<string> {
  const me = getAccountId();
  if (!me) throw new Error('Not signed in.');
  const peer = peerAccountId.trim();
  if (!peer) throw new Error('Enter an account ID.');

  const conversationId = dmConversationId(me, peer);
  const name = preferredName?.trim();

  // The ONE awaited step: a local write, so the chat screen and the list both have a row to
  // render the moment we return. `peerId` is stored here too — the header's presence lookup
  // reads it instead of paying a members round-trip on open.
  await upsertConversation(conversationId, {
    type: 'dm',
    name: name && name !== '' ? name : peer,
    peerId: peer,
  });

  // Everything else converges behind the already-open chat.
  void ensureDmOnServer(me, peer);
  if (!name || name === '') {
    void (async () => {
      try {
        const profile = await getProfile(peer);
        const resolved = profile.displayName?.trim();
        if (resolved)
          await upsertConversation(conversationId, { name: resolved });
      } catch {
        // Best-effort: the peer id remains the label until a later resolution refines it.
      }
    })();
  }

  return conversationId;
}
