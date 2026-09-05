/**
 * Message operations (§L7) — observe a conversation's messages, write an optimistic local
 * send, and reconcile inbound server messages (§L6). The UI reads the DB; the MP2 sync
 * engine transmits via the outbox and applies the server `seq`. Reconcile decisions come
 * from the pure `syncLogic.ts` (client_msg_id → seq); this file only reads/writes rows.
 */
import { Q, Model } from '@nozbe/watermelondb';
import { getDatabase } from './database';
import { Message, Conversation } from './models';
import { reconcileDecision } from './syncLogic';
import { getAccountId } from '../network/tokens';
import type { ServerMessage, SendAck } from '../network/chat';

/** Newest-N window loaded into the chat view (§R5 — bound memory/open cost; a full
 * history could be thousands of rows). "Load older" pagination lands with real sync. */
const MESSAGE_WINDOW = 50;

/**
 * Observe a conversation's newest {@link MESSAGE_WINDOW} messages, newest-first (fed into a
 * reversed list). Bounded by `Q.take` so a large history never materialises on the render
 * path. `observeWithColumns(['state'])` re-emits when a bubble ticks sending→sent→read;
 * reactions/attachments are intentionally NOT observed (the bubble doesn't render them yet)
 * so a receipt burst can't trigger an O(n) re-query for columns nothing draws.
 */
export function observeMessages(
  conversationId: string,
  limit: number = MESSAGE_WINDOW,
) {
  return getDatabase()
    .get<Message>('messages')
    .query(
      Q.where('conversation_id', conversationId),
      Q.where('deleted', false),
      Q.sortBy('created_at', Q.desc),
      Q.take(Math.max(1, limit)),
    )
    .observeWithColumns(['state']);
}

/** How many more messages a "load older" step reveals. */
export const MESSAGE_PAGE = MESSAGE_WINDOW;

/** Total messages held locally for a conversation — tells the UI whether older ones exist. */
export function countMessages(conversationId: string): Promise<number> {
  return getDatabase()
    .get<Message>('messages')
    .query(
      Q.where('conversation_id', conversationId),
      Q.where('deleted', false),
    )
    .fetchCount();
}

/** Lowest seq we hold — the cursor a fetch of OLDER history has to reach back before. */
export async function minSeqForConversation(
  conversationId: string,
): Promise<number> {
  const rows = await getDatabase()
    .get<Message>('messages')
    .query(
      Q.where('conversation_id', conversationId),
      Q.where('seq', Q.gt(0)),
      Q.sortBy('seq', Q.asc),
      Q.take(1),
    )
    .fetch();
  return rows[0]?.seq ?? 0;
}

/** A short client message id (server seq is assigned later, on ACK). */
export function newClientMsgId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Optimistic local send (§L7.sendMessage): write a `sending` message + bump the
 * conversation preview, all in one transaction, so the UI updates instantly. Returns the
 * generated `client_msg_id` so the sync engine can enqueue the matching outbox item (or
 * `null` for an empty body). The outbox worker (MP2) transmits it and the ack flips the
 * state to sent → delivered → read.
 */
export async function sendMessageLocal(
  conversationId: string,
  text: string,
  senderId: string,
): Promise<string | null> {
  const body = text.trim();
  if (!body) return null;
  const db = getDatabase();
  const now = Date.now();
  const clientMsgId = newClientMsgId();
  await db.write(async () => {
    await db.get<Message>('messages').create(m => {
      m.clientMsgId = clientMsgId;
      m.conversationId = conversationId;
      m.senderId = senderId;
      m.type = 'text';
      m.contentPlain = body;
      m.state = 'sending';
      m.deleted = false;
      m.viewOnce = false;
      m.starred = false;
      m.createdAt = now;
    });
    // The conversation row may not exist locally (real conversations are created in
    // group-channel-service, out of MP2 scope) — bump it only when present.
    const conv = await db
      .get<Conversation>('conversations')
      .find(conversationId)
      .catch(() => null);
    if (conv) {
      await conv.update(c => {
        c.lastMessagePreview = body;
        c.lastMessageAt = now;
        c.unreadCount = 0;
        c.updatedAt = now;
      });
    }
  });
  return clientMsgId;
}

// ── inbound reconciliation (§L6) ─────────────────────────────────────────────

interface ConvBump {
  preview: string;
  at: number;
  seq: number;
  unread: number;
  /** The other party (first non-own sender) — used to name a stub for an unknown DM. */
  peerId?: string;
}

function accumulateBump(
  map: Map<string, ConvBump>,
  s: ServerMessage,
  unread: number,
  now: number,
  own: boolean,
): void {
  const at = s.serverTs ?? now;
  const preview = s.content ?? '';
  const prev = map.get(s.conversationId);
  if (!prev) {
    const b: ConvBump = { preview, at, seq: s.seq, unread };
    if (!own) b.peerId = s.senderId;
    map.set(s.conversationId, b);
    return;
  }
  if (s.seq >= prev.seq) {
    prev.preview = preview;
    prev.at = at;
    prev.seq = s.seq;
  }
  prev.unread += unread;
  if (!own && prev.peerId === undefined) prev.peerId = s.senderId;
}

/**
 * Batch-apply inbound server messages in a SINGLE transaction (§L6 "pull → batch-apply →
 * advance"). Each row is reconciled via `reconcileDecision`: our own echo (matched by
 * `client_msg_id`) → UPDATE the optimistic row with the server `seq`; a `seq` we already
 * hold → SKIP; otherwise INSERT. Unread bumps only for inbound from OTHERS, never own echo.
 * Ordering by `seq` (never timestamp). Idempotent — replaying the same window is a no-op.
 */
export async function applyServerMessages(
  servers: ServerMessage[],
): Promise<void> {
  if (servers.length === 0) return;
  const db = getDatabase();
  const meId = getAccountId();
  const msgs = db.get<Message>('messages');
  const convs = db.get<Conversation>('conversations');
  const now = Date.now();
  const sorted = [...servers].sort((a, b) => a.seq - b.seq);
  // Look the whole batch up in TWO queries instead of two per row. The per-row version ran 2N
  // serialised SQLite reads INSIDE the write transaction, holding the writer lock the entire
  // time — so a 100-row backfill blocked every other write behind it, including the optimistic
  // send, and the composer visibly froze the moment a catch-up landed.
  const clientIds = sorted
    .map(s => s.clientMsgId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const seqs = sorted.map(s => s.seq);
  const convIds = [...new Set(sorted.map(s => s.conversationId))];

  const [existingByClient, existingBySeq] = await Promise.all([
    clientIds.length > 0
      ? msgs.query(Q.where('client_msg_id', Q.oneOf(clientIds))).fetch()
      : Promise.resolve([] as Message[]),
    msgs
      .query(
        Q.where('conversation_id', Q.oneOf(convIds)),
        Q.where('seq', Q.oneOf(seqs)),
      )
      .fetch(),
  ]);

  const byClientId = new Map<string, Message>();
  for (const row of existingByClient) {
    if (row.clientMsgId) byClientId.set(row.clientMsgId, row);
  }
  const bySeqKey = new Map<string, Message[]>();
  for (const row of existingBySeq) {
    const key = `${row.conversationId}#${String(row.seq)}`;
    const list = bySeqKey.get(key);
    if (list) list.push(row);
    else bySeqKey.set(key, [row]);
  }

  await db.write(async () => {
    const ops: Model[] = [];
    const bumps = new Map<string, ConvBump>();
    for (const s of sorted) {
      const clientRow = s.clientMsgId
        ? byClientId.get(s.clientMsgId)
        : undefined;
      const byClient = clientRow ? [clientRow] : [];
      const bySeq = bySeqKey.get(`${s.conversationId}#${String(s.seq)}`) ?? [];
      const decision = reconcileDecision({
        hasClientMsgIdRow: byClient.length > 0,
        hasSeqRow: bySeq.length > 0,
      });
      if (decision === 'skip') continue;
      const own = meId !== undefined && s.senderId === meId;
      const nextState = own ? 'sent' : 'delivered';
      if (decision === 'update') {
        const row = byClient[0];
        if (!row) continue;
        // Drop any live-echo dup that already carried this seq (WS raced ahead of the ack).
        for (const d of bySeq) {
          if (d.id !== row.id) ops.push(d.prepareDestroyPermanently());
        }
        ops.push(
          row.prepareUpdate(m => {
            m.seq = s.seq;
            if (s.serverTs !== undefined) m.serverTs = s.serverTs;
            if (s.content !== undefined) m.contentPlain = s.content;
            // don't downgrade a delivered/read receipt back to sent
            if (m.state === 'sending' || m.state === 'failed')
              m.state = nextState;
          }),
        );
        accumulateBump(bumps, s, 0, now, true);
      } else {
        ops.push(
          msgs.prepareCreate(m => {
            m.clientMsgId = s.clientMsgId ?? `srv_${s.conversationId}_${s.seq}`;
            m.conversationId = s.conversationId;
            m.seq = s.seq;
            m.senderId = s.senderId;
            m.type = s.type;
            if (s.content !== undefined) m.contentPlain = s.content;
            if (s.replyToId !== undefined) m.replyToId = s.replyToId;
            m.state = nextState;
            m.deleted = false;
            m.viewOnce = false;
            m.starred = false;
            // created_at is the local timeline sort key; anchor it to server sent_at so a
            // backfilled row lands in the right place (ordering identity is still `seq`).
            m.createdAt = s.serverTs ?? now;
            if (s.serverTs !== undefined) m.serverTs = s.serverTs;
          }),
        );
        accumulateBump(bumps, s, own ? 0 : 1, now, own);
      }
    }
    for (const [convId, b] of bumps) {
      const conv = await convs.find(convId).catch(() => null);
      if (conv) {
        ops.push(
          conv.prepareUpdate(c => {
            if (b.at >= (c.lastMessageAt ?? 0)) {
              c.lastMessagePreview = b.preview;
              c.lastMessageAt = b.at;
              c.lastMessageSeq = b.seq;
            }
            if (b.unread > 0) c.unreadCount = (c.unreadCount ?? 0) + b.unread;
            c.updatedAt = now;
          }),
        );
        continue;
      }
      // §M0: the backend has no inbox endpoint, so an inbound message for a conversation we
      // don't hold locally is how a NEW DM appears. Create a minimal stub (type 'dm', named
      // by the peer/sender until a profile resolves) so it shows in the chat list at once.
      ops.push(
        convs.prepareCreate(c => {
          c._raw.id = convId;
          c.type = 'dm';
          if (b.peerId !== undefined) c.name = b.peerId;
          c.isAnnouncement = false;
          c.isPinned = false;
          c.isArchived = false;
          c.isLocked = false;
          c.lastMessagePreview = b.preview;
          c.lastMessageAt = b.at;
          c.lastMessageSeq = b.seq;
          c.unreadCount = b.unread;
          c.mentionCount = 0;
          c.notifLevel = 'all';
          c.createdAt = now;
          c.updatedAt = now;
        }),
      );
    }
    if (ops.length > 0) await db.batch(...ops);
  });
}

/** Apply a single inbound server message (WS `message` frame). Thin wrapper over the batch. */
export function applyServerMessage(server: ServerMessage): Promise<void> {
  return applyServerMessages([server]);
}

/**
 * Flip our optimistic row to `sent` on the send ACK, stamping the authoritative `seq`.
 * Also destroys any live-echo dup that already carries this seq (WS beat the REST ack) so
 * the invariant "one row per seq" holds regardless of which arrived first.
 */
export async function markMessageSent(
  clientMsgId: string,
  ack: SendAck,
): Promise<void> {
  const db = getDatabase();
  const msgs = db.get<Message>('messages');
  await db.write(async () => {
    const mine = await msgs
      .query(Q.where('client_msg_id', clientMsgId))
      .fetch();
    const row = mine[0];
    if (!row) return;
    const dups = await msgs
      .query(
        Q.where('conversation_id', row.conversationId),
        Q.where('seq', ack.seq),
      )
      .fetch();
    const conv = await db
      .get<Conversation>('conversations')
      .find(row.conversationId)
      .catch(() => null);
    const ops: Model[] = [];
    for (const d of dups) {
      if (d.id !== row.id) ops.push(d.prepareDestroyPermanently());
    }
    ops.push(
      row.prepareUpdate(m => {
        m.seq = ack.seq;
        if (ack.serverTs !== undefined) {
          m.serverTs = ack.serverTs;
          // Re-stamp the ordering key to the SERVER clock. The list is ordered by `created_at`,
          // which was stamped when the user hit send — fine online, hours stale for a message
          // composed offline. Left alone it stays pinned at its compose time, buried under
          // everything that arrived while there was no signal (and, past a window's worth,
          // outside the loaded window entirely), which reads as "my message disappeared".
          // Never move it backwards: a skewed server clock must not re-bury it.
          if (ack.serverTs > m.createdAt) m.createdAt = ack.serverTs;
        }
        if (m.state === 'sending' || m.state === 'failed') m.state = 'sent';
      }),
    );
    if (conv && ack.seq > (conv.lastMessageSeq ?? 0)) {
      ops.push(
        conv.prepareUpdate(c => {
          c.lastMessageSeq = ack.seq;
        }),
      );
    }
    await db.batch(...ops);
  });
}

/**
 * Surface a permanently-failed send in the UI (retry affordance) — state → `failed`.
 *
 * Guarded the same way `markMessageSent` and the inbound reconcile are: only a message still
 * in flight may fail. Sends are idempotent server-side, so a row can be acknowledged (even read
 * by the peer) while its outbox row survives a mid-ack crash and gets re-driven; without this
 * guard a later transport failure would flip a message the recipient has ALREADY READ into a red
 * "failed — tap to retry" bubble. Receipt state only ever moves forward.
 */
export async function markMessageFailed(clientMsgId: string): Promise<void> {
  const db = getDatabase();
  const msgs = db.get<Message>('messages');
  await db.write(async () => {
    const mine = await msgs
      .query(Q.where('client_msg_id', clientMsgId))
      .fetch();
    const row = mine[0];
    if (!row) return;
    if (row.state !== 'sending' && row.state !== 'failed') return;
    await row.update(m => {
      m.state = 'failed';
    });
  });
}

/** Flip a message back to `sending` — used on a manual retry of a failed send (§L6). */
export async function markMessageSending(clientMsgId: string): Promise<void> {
  const db = getDatabase();
  const msgs = db.get<Message>('messages');
  await db.write(async () => {
    const mine = await msgs
      .query(Q.where('client_msg_id', clientMsgId))
      .fetch();
    const row = mine[0];
    if (!row) return;
    await row.update(m => {
      m.state = 'sending';
    });
  });
}

/** The reconnect cursor for a conversation: the highest server `seq` we hold (0 if none). */
export async function maxSeqForConversation(
  conversationId: string,
): Promise<number> {
  const rows = await getDatabase()
    .get<Message>('messages')
    .query(
      Q.where('conversation_id', conversationId),
      Q.where('seq', Q.gt(0)),
      Q.sortBy('seq', Q.desc),
      Q.take(1),
    )
    .fetch();
  return rows[0]?.seq ?? 0;
}

/**
 * Apply a cumulative receipt (§5): advance OUR messages with `seq ≤ upToSeq` to the new
 * state (`delivered`|`read`), monotonically (never downgrade). Bounded by the matched rows.
 */
export async function applyReceipt(
  conversationId: string,
  upToSeq: number,
  state: 'delivered' | 'read',
): Promise<void> {
  if (!(upToSeq > 0)) return;
  const meId = getAccountId();
  if (meId === undefined) return;
  const db = getDatabase();
  const rank: Record<string, number> = {
    sending: 0,
    sent: 1,
    delivered: 2,
    read: 3,
  };
  const target = rank[state] ?? 0;
  // Only states BELOW the target can move. Receipts are cumulative, so `upToSeq` marches toward
  // the conversation maximum — without this predicate a chatty peer's every receipt materialised
  // every message we had ever sent in that conversation (tens of thousands of model instances in
  // a long DM) just to find the one or two rows that actually needed updating.
  const behind = Object.keys(rank).filter(k => (rank[k] ?? 0) < target);
  if (behind.length === 0) return;
  const toUpdate = await db
    .get<Message>('messages')
    .query(
      Q.where('conversation_id', conversationId),
      Q.where('sender_id', meId),
      Q.where('seq', Q.gt(0)),
      Q.where('seq', Q.lte(upToSeq)),
      Q.where('state', Q.oneOf(behind)),
    )
    .fetch();
  if (toUpdate.length === 0) return;
  await db.write(async () => {
    await db.batch(
      ...toUpdate.map(r =>
        r.prepareUpdate(m => {
          m.state = state;
        }),
      ),
    );
  });
}
