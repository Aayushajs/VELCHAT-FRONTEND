/**
 * Durable receipt watermarks (§F2/§C5) — the persistence half of {@link ./receiptLedger}.
 *
 * MMKV, not SQLite, deliberately: this is two small integers per conversation read and written on
 * the message hot path, and it has to survive a process kill. It also avoids a schema migration —
 * the `conversation_members.last_read_seq` column exists but the DB is still schema version 1 with
 * no migration harness, so adding a writer there would be a bigger change than the fix warrants.
 *
 * `desired` = what we want the peer to know. `sent` = what we have actually put on the wire.
 * Persisting BOTH is what makes a receipt survive a socket drop: on reconnect the difference is
 * re-derived and re-emitted, so a frame lost mid-drop costs one extra frame, never a stuck tick.
 */
import { kv } from '../kv';
import {
  EMPTY_WATERMARKS,
  mergeWatermark,
  type ReceiptWatermarks,
} from './receiptLedger';

const DESIRED_PREFIX = 'rcpt.want.';
const SENT_PREFIX = 'rcpt.sent.';
/** What the PEER has told us they know — the inbound direction (their ticks on our messages). */
const PEER_PREFIX = 'rcpt.peer.';

function read(prefix: string, conversationId: string): ReceiptWatermarks {
  const raw = kv.getString(prefix + conversationId);
  if (!raw) return EMPTY_WATERMARKS;
  try {
    const parsed = JSON.parse(raw) as Partial<ReceiptWatermarks>;
    return mergeWatermark(EMPTY_WATERMARKS, {
      delivered: parsed.delivered,
      read: parsed.read,
    });
  } catch {
    // A corrupt entry must not wedge receipts forever — start over from zero.
    return EMPTY_WATERMARKS;
  }
}

function write(
  prefix: string,
  conversationId: string,
  wm: ReceiptWatermarks,
): void {
  kv.set(prefix + conversationId, JSON.stringify(wm));
}

export function getDesired(conversationId: string): ReceiptWatermarks {
  return read(DESIRED_PREFIX, conversationId);
}

export function getSent(conversationId: string): ReceiptWatermarks {
  return read(SENT_PREFIX, conversationId);
}

/**
 * Record what the peer SHOULD know. Returns true when the ledger actually moved, so the caller
 * can skip scheduling a flush for a message it already covered.
 */
export function noteDesired(
  conversationId: string,
  patch: { delivered?: number | undefined; read?: number | undefined },
): boolean {
  const before = getDesired(conversationId);
  const after = mergeWatermark(before, patch);
  if (after === before) return false;
  write(DESIRED_PREFIX, conversationId, after);
  return true;
}

/** Record what we successfully handed to the transport — only ever after `send()` returned true. */
export function noteSent(
  conversationId: string,
  patch: { delivered?: number | undefined; read?: number | undefined },
): void {
  const before = getSent(conversationId);
  const after = mergeWatermark(before, patch);
  if (after !== before) write(SENT_PREFIX, conversationId, after);
}

/**
 * The peer's cumulative watermark for a conversation.
 *
 * Receipts routinely arrive for messages we do not hold yet: on reconnect the `receipt` frame for
 * `up_to_seq: 50` can land before the backfill delivers 46-50. Applied against rows that do not
 * exist, it matched nothing and was gone — and when those rows then arrived as `sent`, nothing
 * remained to lift them, leaving permanent grey ticks on messages the peer had already read.
 * Persisting it lets the backfill re-apply the watermark once the rows exist.
 */
export function getPeerWatermark(conversationId: string): ReceiptWatermarks {
  return read(PEER_PREFIX, conversationId);
}

/** Record what the peer told us, monotonically. Returns true when it actually advanced. */
export function notePeerWatermark(
  conversationId: string,
  patch: { delivered?: number | undefined; read?: number | undefined },
): boolean {
  const before = getPeerWatermark(conversationId);
  const after = mergeWatermark(before, patch);
  if (after === before) return false;
  write(PEER_PREFIX, conversationId, after);
  return true;
}

/**
 * Conversations with receipts still owed. Kept as an explicit index rather than scanning MMKV:
 * a flush runs on every reconnect and after every inbound burst, and scanning every key on a
 * device with thousands of conversations would put that cost on the message hot path.
 */
const dirty = new Set<string>();

export function markDirty(conversationId: string): void {
  dirty.add(conversationId);
}

/** Drain the dirty set — callers re-add on failure so an un-acked flush is retried. */
export function takeDirty(): string[] {
  const ids = [...dirty];
  dirty.clear();
  return ids;
}

export function hasDirty(): boolean {
  return dirty.size > 0;
}

/** Logout: the next account must not inherit this one's receipt state. */
export function clearAllReceipts(): void {
  dirty.clear();
  for (const key of kv.getAllKeys()) {
    if (
      key.startsWith(DESIRED_PREFIX) ||
      key.startsWith(SENT_PREFIX) ||
      key.startsWith(PEER_PREFIX)
    ) {
      kv.delete(key);
    }
  }
}
