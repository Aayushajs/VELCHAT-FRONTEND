/**
 * Chat-list queries (§L5/§F2). The list observes the conversations table so the UI reacts
 * to DB writes — real conversations arrive from `startDm`, inbound messages, and the inbox
 * backfill. No dev seed: the list is always real data (empty until the first real chat).
 */
import { Q } from '@nozbe/watermelondb';
import { getDatabase } from './database';
import { Conversation } from './models';

/**
 * One-time local-chat wipe: removes any previously-seeded fake conversations + messages from
 * the local DB so the list shows ONLY real data (the dev seed used to run on every launch;
 * its rows persist in the DB after we stop seeding). Safe — real conversations are
 * re-discoverable (inbox endpoint) + re-creatable (startDm), and the outbox is a bounded
 * work queue. Guarded by a KV flag at the call site so it runs at most once per install.
 */
export async function purgeAllLocalChat(): Promise<void> {
  const db = getDatabase();
  await db.write(async () => {
    await db.get('messages').query().destroyAllPermanently();
    await db.get('conversations').query().destroyAllPermanently();
    await db.get('outbox').query().destroyAllPermanently();
  });
}

/**
 * Observe the chat list: non-archived, pinned first, then most-recent (§F2).
 * `observeWithColumns` so IN-PLACE field changes (unread cleared, preview updated) also
 * re-render — a plain `.observe()` under a `sortBy` only re-emits on reorder/identity.
 */
export function observeConversations() {
  return getDatabase()
    .get<Conversation>('conversations')
    .query(
      Q.where('is_archived', false),
      // Only chats that actually have a message (WhatsApp): opening a contact creates the
      // conversation row but leaves last_message_at = 0, so it stays OUT of the list until the
      // first message is sent or received (which bumps it). No empty "opened but never
      // messaged" chats cluttering the inbox.
      Q.where('last_message_at', Q.gt(0)),
      Q.sortBy('is_pinned', Q.desc),
      Q.sortBy('last_message_at', Q.desc),
    )
    .observeWithColumns([
      'is_pinned',
      'last_message_at',
      'unread_count',
      'last_message_preview',
      // The row's identity is observed too: revalidation writes a refreshed photo straight to the
      // row, and without these the list would never re-emit — the new picture would sit in the DB
      // and only appear after some unrelated write happened to wake the query.
      'name',
      'peer_id',
      'peer_avatar_url',
    ]);
}

/**
 * All known conversation ids (§L6 reconnect) — the sync engine walks these to send a
 * per-conversation `sync {cursor}` and pull the `afterSeq` backfill. Non-archived only is
 * not required here; sync should catch up every conversation we hold locally.
 */
export async function listConversationIds(): Promise<string[]> {
  const rows = await getDatabase()
    .get<Conversation>('conversations')
    .query()
    .fetch();
  return rows.map(c => c.id);
}

/**
 * A partial conversation row to create-or-update (§M0 — the local DB IS the inbox, since the
 * backend has no list-all-conversations endpoint). Only defined fields are written.
 */
export interface ConversationPatch {
  type?: string;
  name?: string;
  avatarMediaId?: string;
  lastMessagePreview?: string;
  lastMessageAt?: number;
  /** The other member of a DM, resolved once at sync time (the inbox already carries it). */
  peerId?: string;
  /** That peer's photo URL, so a list row never fetches one while the user is scrolling. */
  peerAvatarUrl?: string;
}

/**
 * Observe ONE conversation row. The chat header reads its peer/name/photo from here, so opening a
 * chat costs no network, and a background refresh of that identity re-renders the header on its own.
 */
/** Minimal shape of what WatermelonDB's observers emit — avoids depending on rxjs directly. */
export interface RowStream<T> {
  subscribe(next: (rows: T[]) => void): { unsubscribe: () => void };
}

export function observeConversation(
  conversationId: string,
): RowStream<Conversation> {
  return getDatabase()
    .get<Conversation>('conversations')
    .query(Q.where('id', conversationId))
    .observeWithColumns(['name', 'peer_id', 'peer_avatar_url']);
}

/** The DM peer stored on the row, if the inbox sync has resolved one. No network. */
export async function peerIdFor(
  conversationId: string,
): Promise<string | undefined> {
  const row = await getDatabase()
    .get<Conversation>('conversations')
    .find(conversationId)
    .catch(() => null);
  return row?.peerId;
}

/**
 * How old the cached peer name/photo is, in ms — `null` when we have never resolved one.
 * Drives revalidation: fast render from the row, corrected in the background when it goes stale.
 */
export async function peerIdentityAgeMs(
  conversationId: string,
): Promise<number | null> {
  const row = await getDatabase()
    .get<Conversation>('conversations')
    .find(conversationId)
    .catch(() => null);
  const at = row?.peerAvatarAt;
  return at === undefined || at === null ? null : Date.now() - at;
}

/**
 * Create-or-update a conversation row keyed by the SERVER conversationId (§M0). Used by
 * `startDm` (user starts a DM) and, indirectly, wherever a conversation must appear in the
 * local inbox. Idempotent: a second call with the same id updates in place. Serialised via
 * the WatermelonDB writer (one writer at a time), so concurrent upserts for the same id can't
 * both create — the second sees the first's row. The row `id` is set to `conversationId` so
 * `find(conversationId)` (preview bumps, unread clear, receipts) resolves it.
 */
export async function upsertConversation(
  conversationId: string,
  patch: ConversationPatch,
): Promise<void> {
  const db = getDatabase();
  const col = db.get<Conversation>('conversations');
  const now = Date.now();
  await db.write(async () => {
    const existing = await col.find(conversationId).catch(() => null);
    if (existing) {
      await existing.update(c => {
        if (patch.type !== undefined) c.type = patch.type;
        if (patch.name !== undefined) c.name = patch.name;
        if (patch.avatarMediaId !== undefined) {
          c.avatarMediaId = patch.avatarMediaId;
        }
        // Identity is written by the inbox sync; the message path upserts only a preview. Applying
        // these ONLY when present is what stops every incoming message from blanking the row's
        // photo (an `undefined` patch field means "unchanged", never "clear it").
        if (patch.peerId !== undefined) c.peerId = patch.peerId;
        if (patch.peerAvatarUrl !== undefined) {
          c.peerAvatarUrl = patch.peerAvatarUrl;
          c.peerAvatarAt = now;
        }
        if (patch.lastMessagePreview !== undefined) {
          c.lastMessagePreview = patch.lastMessagePreview;
        }
        // Never move the sort key backwards (a stale patch mustn't reorder the list).
        if (
          patch.lastMessageAt !== undefined &&
          patch.lastMessageAt >= (c.lastMessageAt ?? 0)
        ) {
          c.lastMessageAt = patch.lastMessageAt;
        }
        c.updatedAt = now;
      });
      return;
    }
    await col.create(c => {
      c._raw.id = conversationId;
      c.type = patch.type ?? 'dm';
      if (patch.name !== undefined) c.name = patch.name;
      if (patch.avatarMediaId !== undefined)
        c.avatarMediaId = patch.avatarMediaId;
      if (patch.peerId !== undefined) c.peerId = patch.peerId;
      if (patch.peerAvatarUrl !== undefined) {
        c.peerAvatarUrl = patch.peerAvatarUrl;
        c.peerAvatarAt = now;
      }
      c.isAnnouncement = false;
      c.isPinned = false;
      c.isArchived = false;
      c.isLocked = false;
      if (patch.lastMessagePreview !== undefined) {
        c.lastMessagePreview = patch.lastMessagePreview;
      }
      // A conversation with no message yet stays OUT of the inbox list (last_message_at = 0);
      // the first sent/received message bumps it in. `observeConversations` filters on this.
      c.lastMessageAt = patch.lastMessageAt ?? 0;
      c.unreadCount = 0;
      c.mentionCount = 0;
      c.notifLevel = 'all';
      c.createdAt = now;
      c.updatedAt = now;
    });
  });
}

/**
 * Clear a conversation's unread badge (§F2) — called when the user opens the chat. A
 * no-op if it's already 0 so an open doesn't churn a needless write/re-emit.
 */
export async function clearUnread(conversationId: string): Promise<void> {
  const db = getDatabase();
  const conv = await db
    .get<Conversation>('conversations')
    .find(conversationId)
    .catch(() => null);
  if (!conv || conv.unreadCount === 0) return;
  await db.write(async () => {
    await conv.update(c => {
      c.unreadCount = 0;
    });
  });
}
