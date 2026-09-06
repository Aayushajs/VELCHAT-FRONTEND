/**
 * Receipt ledger (§F2/§C5) — pure decision logic for delivered/read receipts. NO I/O.
 *
 * Receipts are cumulative: one frame carries `up_to_seq` and covers every message at or below
 * it. Three facts make a watermark ledger the only correct shape here:
 *
 *  1. The gateway drops inbound frames above ~40/sec per connection, silently and SHARED — so a
 *     per-message `delivered` during a 100-message catch-up doesn't just waste the budget, it
 *     takes the `read` and `sync` frames down with it.
 *  2. The transport drops sends when the socket isn't OPEN and reports nothing. A receipt emitted
 *     mid-reconnect is simply gone, so "what the peer should know" must outlive the socket.
 *  3. Receipts are `ephemeral` server-side, i.e. explicitly coalescible under backpressure. The
 *     client cannot assume any single frame survived.
 *
 * So the client tracks, per conversation, what it WANTS the peer to know (`desired`) against what
 * it has successfully put on the wire (`sent`), and re-derives the difference on every flush and
 * every reconnect. A lost frame costs one extra frame later; it can never cost a stuck grey tick.
 */

export interface ReceiptWatermarks {
  /** Highest seq we have persisted locally for this conversation. */
  delivered: number;
  /** Highest seq the user has actually seen (chat open + scrolled to it). */
  read: number;
}

export type ReceiptState = 'delivered' | 'read';

export interface ReceiptFrame {
  state: ReceiptState;
  upToSeq: number;
}

export const EMPTY_WATERMARKS: ReceiptWatermarks = { delivered: 0, read: 0 };

/** A seq is usable only if it is a finite, positive number — seq 0 means "nothing yet". */
function usableSeq(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Advance a conversation's watermarks. Monotonic by construction: a stale frame, an
 * out-of-order apply, or a re-read of older history can never move a watermark backwards, so
 * the peer's ticks can never regress.
 *
 * Returns the SAME object when nothing moved, so callers can skip a persist.
 */
export function mergeWatermark(
  current: ReceiptWatermarks,
  patch: { delivered?: number | undefined; read?: number | undefined },
): ReceiptWatermarks {
  const d = usableSeq(patch.delivered);
  const r = usableSeq(patch.read);

  // A read is proof of delivery: you cannot read what was never delivered. Without this the
  // ledger could hold read > delivered and then emit a redundant delivered frame to "catch up".
  const nextRead = r !== null && r > current.read ? r : current.read;
  const deliveredFromRead = Math.max(nextRead, current.delivered);
  const nextDelivered =
    d !== null && d > deliveredFromRead ? d : deliveredFromRead;

  if (nextDelivered === current.delivered && nextRead === current.read)
    return current;
  return { delivered: nextDelivered, read: nextRead };
}

/**
 * The frames still owed to the peer: the difference between what we want them to know and what
 * we have actually managed to send. At most one frame per state, and `read` subsumes `delivered`
 * at or below it (read is strictly stronger, and both are cumulative), so the common case —
 * "user is reading the chat as messages land" — costs exactly one frame per flush.
 */
export function pendingReceiptFrames(
  desired: ReceiptWatermarks,
  sent: ReceiptWatermarks,
): ReceiptFrame[] {
  const frames: ReceiptFrame[] = [];
  if (desired.read > sent.read)
    frames.push({ state: 'read', upToSeq: desired.read });
  // Only worth saying "delivered up to N" when N is beyond what the read frame already implies.
  const impliedByRead = Math.max(desired.read, sent.read);
  if (desired.delivered > sent.delivered && desired.delivered > impliedByRead) {
    frames.push({ state: 'delivered', upToSeq: desired.delivered });
  }
  return frames;
}

/** A parsed inbound receipt: what the PEER has acknowledged, for this conversation. */
export interface InboundReceipt {
  conversationId: string;
  upToSeq: number;
  state: ReceiptState;
}

/** Read a string field under either casing. */
function frameString(
  d: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const v = d[snake] ?? d[camel];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Parse an inbound `receipt` frame, returning `null` for anything that must not be applied.
 *
 * The SELF-ECHO filter is the important part. The realtime-gateway's fan-out
 * (`fanout-consumer.onReceipt`) routes a receipt to EVERY member of the conversation —
 * including the member who just acknowledged — and `MessageReceiptPayload.user_id` is
 * documented as "the recipient who acknowledged". Applying our own echo marks OUR OWN sent
 * messages delivered/read the moment WE open the chat, so the ticks end up describing the
 * reader's own behaviour instead of the peer's. `applyReceipt` filters on `sender_id = me`,
 * which is exactly the set our own echo would (wrongly) lift.
 *
 * A frame with NO `user_id` is kept: older/pre-migration gateways omitted it, and dropping those
 * would trade a wrong tick for a permanently stuck one. Likewise when our own id is unknown —
 * we cannot prove a self-echo, and a real receipt must not be discarded on a guess.
 */
export function parseReceiptFrame(
  data: unknown,
  meId: string | undefined,
  opts: { selfChat?: boolean } = {},
): InboundReceipt | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  const conversationId = frameString(d, 'conversation_id', 'conversationId');
  if (conversationId === undefined) return null;

  const state =
    d.state === 'read' ? 'read' : d.state === 'delivered' ? 'delivered' : null;
  if (state === null) return null;

  const seqRaw = d.up_to_seq ?? d.upToSeq ?? d.seq;
  const upToSeq =
    typeof seqRaw === 'number'
      ? seqRaw
      : typeof seqRaw === 'string' && seqRaw.trim() !== ''
        ? Number(seqRaw)
        : NaN;
  if (!Number.isFinite(upToSeq) || upToSeq <= 0) return null;

  // Our own acknowledgement, fanned back to us — never apply it to our own bubbles.
  //
  // Except in a conversation whose only member IS us ("Message yourself"), where our own receipt
  // is the only one that will ever arrive. Discarding it there leaves those ticks stuck on `sent`
  // forever, however plainly the message was delivered and read.
  const actor = frameString(d, 'user_id', 'userId') ?? d.account_id;
  if (
    !opts.selfChat &&
    meId !== undefined &&
    typeof actor === 'string' &&
    actor !== '' &&
    actor === meId
  ) {
    return null;
  }

  return { conversationId, upToSeq: Math.floor(upToSeq), state };
}
