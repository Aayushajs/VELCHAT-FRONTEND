/**
 * Observe the chat list from the local DB (§F2, §M0). The UI reads WatermelonDB, never
 * the network — an instant, offline-first render that reacts to every DB write. Real
 * conversations arrive from `startDm` + the sync engine + the inbox backfill; empty until
 * the user starts/receives their first chat (no dev seed — the list is always real data).
 *
 * The hook hands the UI PLAIN ROW VIEW-MODELS, not the DB models: WatermelonDB mutates its
 * cached model IN PLACE and re-emits the SAME object reference, so anything memoised on the
 * model (our `Row`, and FlashList's own ViewHolder `prevProps.item === nextProps.item`)
 * would never see a cleared unread badge or a new preview on the chat already at the top.
 * Snapshotting primitives per emission makes the memo correct — the same trap MessageBubble
 * documents.
 */
import { useEffect, useState } from 'react';
import { observeConversations, Conversation } from '../../../infra';

/** One chat-list row, as the UI renders it. Immutable primitives only — never a DB model. */
export interface ConversationRowVM {
  readonly id: string;
  readonly type: string;
  readonly name: string | undefined;
  readonly preview: string;
  readonly unread: number;
  readonly pinned: boolean;
  /**
   * Rendered timestamp, resolved at EMISSION time. `toLocaleTimeString`/`toLocaleDateString`
   * are ICU calls over JNI on Hermes — far too slow to run per row per render (§R4), and the
   * label only changes when the row does. Trade-off: an app left open across midnight keeps
   * yesterday's buckets until the next DB emission (which memoised rows did anyway).
   */
  readonly time: string;
  /** The DM's other member, resolved at sync time — never looked up while rendering. */
  readonly peerId: string | undefined;
  /** That peer's photo URL, already resolved. Absent → the row draws a coloured initial. */
  readonly peerAvatarUrl: string | undefined;
}

export interface ConversationsState {
  readonly rows: readonly ConversationRowVM[];
  /**
   * False until the FIRST subscription emission. Without this the list renders its
   * "no chats yet" empty state on every cold start / tab mount and then swaps to the
   * rows — a visible flash of the wrong screen.
   */
  readonly loaded: boolean;
}

const INITIAL: ConversationsState = { rows: [], loaded: false };

/** Compact WhatsApp-style timestamp: HH:MM today, else a short date. `now` = emission time. */
export function conversationTimeLabel(
  ts: number | undefined,
  now: number,
): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Snapshot a DB model into a row view-model. Pure — the unit of the memo contract above. */
export function toConversationRow(
  c: Conversation,
  now: number,
): ConversationRowVM {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    preview: c.lastMessagePreview ?? '',
    unread: c.unreadCount,
    pinned: c.isPinned,
    time: conversationTimeLabel(c.lastMessageAt, now),
    // Carried on the row itself, resolved once at sync time. A row that had to FETCH its peer and
    // photo cost three REST calls per render — which is why photos used to arrive late, in a
    // random order, or not at all, and why the list crawled on a real connection.
    peerId: c.peerId,
    peerAvatarUrl: c.peerAvatarUrl,
  };
}

export function useConversations(): ConversationsState {
  const [state, setState] = useState<ConversationsState>(INITIAL);
  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    try {
      // getDatabase() throws if the native module isn't in the binary yet (pre-rebuild) —
      // degrade to an empty list instead of crashing the tab.
      sub = observeConversations().subscribe(models => {
        // One `now` per emission so every row is bucketed against the same instant.
        const now = Date.now();
        setState({
          rows: models.map(m => toConversationRow(m, now)),
          loaded: true,
        });
      });
    } catch {
      // Loaded-but-empty: the empty state is the correct, final answer here.
      setState({ rows: [], loaded: true });
    }
    return () => sub?.unsubscribe();
  }, []);
  return state;
}
