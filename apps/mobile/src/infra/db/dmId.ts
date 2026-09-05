/**
 * Deterministic DM conversation id — a byte-exact port of the backend's
 * `libs/feature-group-channel/src/channels/dm-id.ts` (§B7).
 *
 * WHY the client needs it: `POST /conversations/dm` is idempotent and its id depends only on
 * the member pair, so awaiting that round-trip before showing the chat bought nothing but a
 * failure mode — offline (or on any transient backend error) the promise rejected and the New
 * Chat tap simply did nothing. Deriving the id locally lets the chat open instantly, WhatsApp
 * style, while the create call converges in the background.
 *
 * The server call is still required and must still happen: it inserts the conversation + members
 * and emits `conversation.created`, which seeds the realtime-gateway's membership projection —
 * and message fan-out returns early for a conversation with no known members, so skipping it
 * would produce a chat whose messages never reach the peer live.
 *
 * Verified against backend-generated known-answer vectors in `__tests__/dmId.test.ts`.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** Hex characters of the digest kept by the backend (128 bits). */
const ID_HEX_LEN = 32;

/**
 * The conversation id for a DM between `a` and `b`. Order-independent (the pair is sorted), so
 * both participants derive the same thread. `a === b` is the WhatsApp-style note-to-self chat.
 *
 * Throws on a blank id: every blank would otherwise collapse onto one shared bogus conversation.
 */
export function dmConversationId(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (x === '' || y === '') {
    throw new Error('dmConversationId: both account ids are required');
  }
  const [lo, hi] = [x, y].sort();
  const digest = bytesToHex(sha256(utf8ToBytes(`${lo}|${hi}`)));
  return `dm-${digest.slice(0, ID_HEX_LEN)}`;
}
