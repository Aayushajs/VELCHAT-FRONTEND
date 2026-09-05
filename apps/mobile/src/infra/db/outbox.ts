/**
 * Outbox DB writers (§L6) — the durable send queue. Thin persistence around the PURE
 * decision logic in `syncLogic.ts` (`nextOutboxRetry` + `backoffMs`); this file only reads/
 * writes rows, it holds NO policy of its own.
 *
 * Ordering contract: per-conversation FIFO with single-flight. `claimNextDue` only ever
 * hands out the head-of-line item of a conversation (oldest `created_at`), and never a
 * second item while one in that conversation is still `sending` — so a message can't
 * overtake an earlier one in the same chat. All mutations run under a serialising lock so
 * a StrictMode double-invoke (or two concurrent worker ticks) can't double-claim a row.
 */
import { Q } from '@nozbe/watermelondb';
import { getDatabase } from './database';
import { Outbox, Message, Conversation } from './models';
import { newClientMsgId } from './messages';
import { backoffMs, nextOutboxRetry } from './syncLogic';
import type { SendMessageInput } from '../network/chat';

/** The kind stored on a text/message send row (the schema `kind` column). */
const KIND_SEND = 'message.send';

/** A claimed, ready-to-transmit outbox item (payload parsed back into a SendMessageInput). */
export interface OutboxItem {
  /** WatermelonDB record id (opaque). */
  id: string;
  conversationId: string;
  clientMsgId: string;
  /** attempts BEFORE this send (0 on first try). */
  attempts: number;
  input: SendMessageInput;
}

/** Snapshot used by the engine to schedule the next drain without hot-spinning. */
export interface OutboxStats {
  /** count of items still queued (due or backing off). */
  queued: number;
  /** earliest `next_attempt_at` among queued items, or null when none are queued. */
  nextDueAt: number | null;
}

// ── serialising lock ─────────────────────────────────────────────────────────
// Every outbox mutation chains behind the previous one so claim/enqueue/ack/fail can never
// interleave (which is how two ticks could both flip the same row to `sending`).
let lock: Promise<unknown> = Promise.resolve();
function withOutboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseInput(payload: string): SendMessageInput | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === 'object') return parsed as SendMessageInput;
  } catch {
    // corrupt payload — treated as un-claimable below
  }
  return null;
}

/**
 * Enqueue a durable send. `next_attempt_at = now` → immediately due. `payload` is the full
 * `SendMessageInput` so the worker can retry the SAME clientMsgId (idempotent server-side).
 */
export function enqueueSend(
  conversationId: string,
  _clientMsgId: string,
  payload: SendMessageInput,
): Promise<void> {
  return withOutboxLock(async () => {
    const db = getDatabase();
    const now = Date.now();
    const json = JSON.stringify(payload);
    await db.write(async () => {
      await db.get<Outbox>('outbox').create(o => {
        o.kind = KIND_SEND;
        o.conversationId = conversationId;
        o.payload = json;
        o.state = 'queued';
        o.attempts = 0;
        o.nextAttemptAt = now;
        o.createdAt = now;
        o.updatedAt = now;
      });
    });
  });
}

/**
 * Compose a message: write the optimistic bubble AND its outbox row in ONE transaction (§L6/§L7).
 *
 * A send is a single fact, so it cannot be two writes. Split across two transactions, a process
 * death in between — or the second write simply throwing under disk pressure — strands a message
 * row in `sending` with nothing queued to transmit it. Crash recovery only repairs OUTBOX rows,
 * so nothing ever revisits that bubble: it is never sent, never fails, and keeps its clock icon
 * across every relaunch with no retry affordance. One transaction makes that state unreachable.
 *
 * Returns the `client_msg_id` (the idempotency key the server dedupes on), or `null` when there
 * is nothing legitimate to send.
 */
export function enqueueOptimisticSend(
  conversationId: string,
  text: string,
  senderId: string,
): Promise<string | null> {
  const body = text.trim();
  // A blank body has nothing to deliver. A blank sender is worse than nothing: the backend
  // refuses a senderId that disagrees with the token, so queueing one burns every retry on a
  // guaranteed 4xx and ends as a red bubble the user can never fix.
  if (!body || !senderId) return Promise.resolve(null);

  return withOutboxLock(async () => {
    const db = getDatabase();
    const now = Date.now();
    const clientMsgId = newClientMsgId();
    const payload: SendMessageInput = {
      conversationId,
      senderId,
      clientMsgId,
      type: 'text',
      content: body,
    };
    const json = JSON.stringify(payload);

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
      await db.get<Outbox>('outbox').create(o => {
        o.kind = KIND_SEND;
        o.conversationId = conversationId;
        o.payload = json;
        o.state = 'queued';
        o.attempts = 0;
        o.nextAttemptAt = now;
        o.createdAt = now;
        o.updatedAt = now;
      });
      // The conversation row may not exist locally yet (conversations are owned server-side) —
      // bump the list preview only when it does.
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
  });
}

/**
 * Claim the next due, head-of-line item and flip it `queued`→`sending` atomically. Returns
 * null when nothing is due (or every due item is blocked behind an in-flight sibling in its
 * conversation). Respects per-conversation FIFO + single-flight.
 */
export function claimNextDue(now: number): Promise<OutboxItem | null> {
  return withOutboxLock(async () => {
    const db = getDatabase();
    const col = db.get<Outbox>('outbox');
    const pending = await col
      .query(
        Q.where('kind', KIND_SEND),
        Q.where('state', Q.oneOf(['queued', 'sending'])),
      )
      .fetch();
    if (pending.length === 0) return null;

    // Per-conversation head-of-line = min created_at; and conversations already sending.
    const oldestByConv = new Map<string, number>();
    const sendingConvs = new Set<string>();
    for (const o of pending) {
      const conv = o.conversationId ?? '';
      const prev = oldestByConv.get(conv);
      if (prev === undefined || o.createdAt < prev)
        oldestByConv.set(conv, o.createdAt);
      if (o.state === 'sending') sendingConvs.add(conv);
    }

    const due = pending
      .filter(o => o.state === 'queued' && (o.nextAttemptAt ?? 0) <= now)
      .sort((a, b) => a.createdAt - b.createdAt);

    const candidate = due.find(o => {
      const conv = o.conversationId ?? '';
      return !sendingConvs.has(conv) && oldestByConv.get(conv) === o.createdAt;
    });
    if (!candidate) return null;

    const input = parseInput(candidate.payload);
    if (!input || !input.clientMsgId) {
      // Un-parseable/legacy row — drop it so it can't wedge the queue forever.
      await db.write(async () => {
        await candidate.destroyPermanently();
      });
      return null;
    }

    await db.write(async () => {
      await candidate.update(o => {
        o.state = 'sending';
        o.updatedAt = now;
      });
    });

    return {
      id: candidate.id,
      conversationId: candidate.conversationId ?? input.conversationId,
      clientMsgId: input.clientMsgId,
      attempts: candidate.attempts,
      input,
    };
  });
}

/** Ack → the work is done; remove the row (the outbox is a bounded work queue, not a log). */
export function markAckd(id: string): Promise<void> {
  return withOutboxLock(async () => {
    const db = getDatabase();
    const col = db.get<Outbox>('outbox');
    const row = await col.find(id).catch(() => null);
    if (!row) return;
    await db.write(async () => {
      await row.destroyPermanently();
    });
  });
}

/**
 * Record a failed send. `attempts` is the count AFTER incrementing for this failure.
 * `nextOutboxRetry` decides queued-with-backoff vs permanently failed (§L6); backoff uses
 * the shared full-jitter schedule so a fleet doesn't retry in lockstep.
 */
export function markFailed(
  id: string,
  error: string,
  attempts: number,
  /**
   * Override the attempt-count verdict with the CAUSE of the failure.
   *
   * Attempts alone are the wrong signal: eight failures because the phone is in a tunnel say
   * nothing bad about the message, while one 400 says everything. `false` keeps the row retrying
   * (clock icon, WhatsApp behaviour); `true` retires it immediately so the user gets the retry
   * affordance now instead of after eight pointless replays of a rejected payload.
   */
  permanent?: boolean,
): Promise<void> {
  return withOutboxLock(async () => {
    const db = getDatabase();
    const col = db.get<Outbox>('outbox');
    const row = await col.find(id).catch(() => null);
    if (!row) return;
    const now = Date.now();
    const state =
      permanent === undefined
        ? nextOutboxRetry(attempts).state
        : permanent
          ? 'failed'
          : 'queued';
    const retryAt = state === 'queued' ? now + backoffMs(attempts) : undefined;
    await db.write(async () => {
      await row.update(o => {
        o.state = state;
        o.attempts = attempts;
        o.lastError = error.slice(0, 500);
        // On a retry, arm the next-due time; on permanent failure leave the stale value
        // (a `failed` row is never claimed, so it's inert) — avoids an undefined write
        // under exactOptionalPropertyTypes.
        if (retryAt !== undefined) o.nextAttemptAt = retryAt;
        o.updatedAt = now;
      });
    });
  });
}

/**
 * Startup crash-recovery. A process killed mid-send (backgrounded during an in-flight POST
 * — routine on a low-RAM device) leaves its row stuck in `sending`: nothing re-claims a
 * `sending` row, and single-flight blocks every later message in that conversation, so the
 * queue wedges forever (and the engine's timer busy-loops). Reset every `sending` row back
 * to `queued`, due now — re-sending is safe (idempotent by clientMsgId server-side).
 *
 * MUST be called once at engine start, BEFORE the first drain, when nothing is genuinely
 * in-flight — so any `sending` row is necessarily an orphan from a prior process. Returns
 * how many rows were recovered.
 */
export function recoverStuckSends(): Promise<number> {
  return withOutboxLock(async () => {
    const db = getDatabase();
    const col = db.get<Outbox>('outbox');
    const stuck = await col
      .query(Q.where('kind', KIND_SEND), Q.where('state', 'sending'))
      .fetch();
    if (stuck.length === 0) return 0;
    const now = Date.now();
    await db.write(async () => {
      await db.batch(
        stuck.map(o =>
          o.prepareUpdate(row => {
            row.state = 'queued';
            row.nextAttemptAt = now;
            row.updatedAt = now;
          }),
        ),
      );
    });
    return stuck.length;
  });
}

/**
 * Manual retry (§L6 "surface retry"): re-arm a permanently-`failed` send so the worker
 * picks it up again. Resets attempts to 0 and makes it due now. Returns false if no failed
 * row matches (e.g. it already drained). Re-send is idempotent server-side by clientMsgId.
 */
export function requeueFailed(clientMsgId: string): Promise<boolean> {
  return withOutboxLock(async () => {
    const db = getDatabase();
    const col = db.get<Outbox>('outbox');
    const failed = await col
      .query(Q.where('kind', KIND_SEND), Q.where('state', 'failed'))
      .fetch();
    const match = failed.find(
      o => parseInput(o.payload)?.clientMsgId === clientMsgId,
    );
    if (!match) return false;
    const now = Date.now();
    await db.write(async () => {
      await match.update(o => {
        o.state = 'queued';
        o.attempts = 0;
        o.nextAttemptAt = now;
        o.updatedAt = now;
      });
    });
    return true;
  });
}

/** Snapshot for the engine's self-adjusting timer (never poll a hot loop). */
export function outboxStats(): Promise<OutboxStats> {
  return withOutboxLock(async () => {
    const db = getDatabase();
    const col = db.get<Outbox>('outbox');
    const queued = await col
      .query(Q.where('kind', KIND_SEND), Q.where('state', 'queued'))
      .fetch();
    let nextDueAt: number | null = null;
    for (const o of queued) {
      const at = o.nextAttemptAt ?? o.createdAt;
      if (nextDueAt === null || at < nextDueAt) nextDueAt = at;
    }
    return { queued: queued.length, nextDueAt };
  });
}
