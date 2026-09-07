/**
 * Parsing the notification-action queue — PURE, no RN, no I/O.
 *
 * These values cross a native → JS boundary where everything is loosely typed, and they arrive
 * from a process that may have been killed and restarted since the user pressed the button. A
 * malformed entry must therefore cost exactly one dropped action, never a crash on a launch path
 * and never a half-applied one: `takePendingEvents` has already emptied the native queue by the
 * time these are parsed, so there is nothing to retry against.
 *
 * The strictness is deliberate. A `reply` with no text would post an empty message; a `read`
 * with a bad seq would move a watermark to `NaN` and wedge every later receipt comparison. Both
 * are worse than silently dropping the action.
 */
import type { PushPendingEvent } from './types';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * A positive integer, or undefined. Native sends numbers as numbers, but a value that round-tripped
 * through JSON as a string still has to parse — and anything else must not become `NaN`.
 */
function seq(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Parse one queued native event. Returns null for anything that must not be acted on. */
export function parsePendingEvent(raw: unknown): PushPendingEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  switch (e.type) {
    case 'reply': {
      const conversationId = str(e.conversationId);
      // The message body is NOT trimmed to empty and sent anyway — a whitespace-only inline
      // reply is a mis-tap, and posting it would be indistinguishable from a bug.
      const text = str(e.text);
      if (!conversationId || !text) return null;
      const upTo = seq(e.upToSeq);
      const at = seq(e.at);
      return {
        type: 'reply',
        conversationId,
        text,
        ...(upTo !== undefined ? { upToSeq: upTo } : {}),
        ...(at !== undefined ? { at } : {}),
      };
    }

    case 'read': {
      const conversationId = str(e.conversationId);
      if (!conversationId) return null;
      const upTo = seq(e.upToSeq);
      return {
        type: 'read',
        conversationId,
        ...(upTo !== undefined ? { upToSeq: upTo } : {}),
      };
    }

    case 'mute': {
      const conversationId = str(e.conversationId);
      const mutedUntil = seq(e.mutedUntil);
      if (!conversationId || mutedUntil === undefined) return null;
      return { type: 'mute', conversationId, mutedUntil };
    }

    case 'token': {
      const token = str(e.token);
      return token ? { type: 'token', token } : null;
    }

    case 'resync':
      return { type: 'resync' };

    default:
      // A newer native build queued a type this JS bundle does not model. Dropping it is right:
      // acting on a shape we cannot read is how a "reply" becomes a message to the wrong chat.
      return null;
  }
}

/** Parse a whole drained batch, discarding the entries that cannot be trusted. */
export function parsePendingEvents(raw: unknown): PushPendingEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: PushPendingEvent[] = [];
  for (const item of raw) {
    const parsed = parsePendingEvent(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Collapse a batch so it can be applied safely.
 *
 * Two things make this necessary rather than cosmetic:
 *
 *  1. **Replies must keep their order.** Two inline replies to the same chat are two messages,
 *     and swapping them is a visible corruption. They are never merged.
 *  2. **Reads and mutes are idempotent watermarks**, and a batch can hold several for one
 *     conversation (mark-as-read, then a reply's implicit read). Keeping only the strongest —
 *     the highest seq, the latest mute — turns N redundant round trips into one.
 *
 * A `read` that a later `reply` in the same batch already implies is dropped, since sending the
 * reply marks the conversation read anyway.
 */
export function collapsePendingEvents(
  events: readonly PushPendingEvent[],
): PushPendingEvent[] {
  const replies: PushPendingEvent[] = [];
  const reads = new Map<string, number>();
  const mutes = new Map<string, number>();
  let token: PushPendingEvent | null = null;
  let resync = false;

  for (const e of events) {
    switch (e.type) {
      case 'reply':
        replies.push(e);
        if (e.upToSeq !== undefined) {
          reads.set(
            e.conversationId,
            Math.max(reads.get(e.conversationId) ?? 0, e.upToSeq),
          );
        }
        break;
      case 'read':
        if (e.upToSeq !== undefined) {
          reads.set(
            e.conversationId,
            Math.max(reads.get(e.conversationId) ?? 0, e.upToSeq),
          );
        } else if (!reads.has(e.conversationId)) {
          // "Read, seq unknown" still has to clear the local badge, so keep it as a zero.
          reads.set(e.conversationId, 0);
        }
        break;
      case 'mute':
        mutes.set(
          e.conversationId,
          Math.max(mutes.get(e.conversationId) ?? 0, e.mutedUntil),
        );
        break;
      case 'token':
        token = e; // the newest token wins; older ones are already dead
        break;
      case 'resync':
        resync = true;
        break;
    }
  }

  const out: PushPendingEvent[] = [...replies];
  for (const [conversationId, upToSeq] of reads) {
    out.push({
      type: 'read',
      conversationId,
      ...(upToSeq > 0 ? { upToSeq } : {}),
    });
  }
  for (const [conversationId, mutedUntil] of mutes) {
    out.push({ type: 'mute', conversationId, mutedUntil });
  }
  if (token) out.push(token);
  if (resync) out.push({ type: 'resync' });
  return out;
}
