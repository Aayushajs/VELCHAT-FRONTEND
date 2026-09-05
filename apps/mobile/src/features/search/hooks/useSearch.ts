/**
 * Search data hook (§F1, §M0) — the feature-layer bridge between the UI and infra. The UI
 * (`ui/`) never touches infra directly; it calls this hook, which queries the LOCAL DB.
 *
 * - `frequent`: the user's most-recent conversations, OBSERVED from the DB (live), for the
 *   browse-state avatar row.
 * - `results`: a ONE-SHOT search over conversations + messages, re-run on each debounced
 *   query change. A per-run `active` flag guards against a slower stale query overwriting a
 *   newer one; the debounce timer + DB subscription are both disposed on cleanup (§M20.3).
 * Nothing here blocks the render path — the query runs off the debounce timer, async.
 */
import { useEffect, useState } from 'react';
import {
  searchConversations,
  searchMessages,
  fetchConversationNames,
  observeConversations,
  Conversation,
} from '../../../infra';
import type { SearchResult, FrequentChat } from '../model/types';
import { timeLabel } from '../model/format';

/** Debounce before hitting the DB — one query per settled keystroke, not per character. */
const DEBOUNCE_MS = 200;
/** How many recent conversations to surface in the browse-state "Frequent" row. */
const FREQUENT_LIMIT = 5;
/** Fallback title when a conversation has no name (matched via preview, or a bare stub). */
const NO_NAME = '—';

interface Ranked {
  at: number;
  result: SearchResult;
}

/** Run the two local searches, resolve chat names for message hits, merge + sort. */
async function runSearch(q: string): Promise<SearchResult[]> {
  const [convs, msgs] = await Promise.all([
    searchConversations(q),
    searchMessages(q),
  ]);

  // Join: resolve which chat each message hit belongs to (one batched query).
  const names = await fetchConversationNames(msgs.map(m => m.conversationId));

  const ranked: Ranked[] = [];

  for (const c of convs) {
    const title = c.name || NO_NAME;
    ranked.push({
      at: c.lastMessageAt,
      result: {
        id: `c_${c.id}`,
        kind: 'chat',
        title,
        subtitle: c.lastMessagePreview,
        conversationId: c.id,
        conversationName: title,
        ...(c.lastMessageAt ? { time: timeLabel(c.lastMessageAt) } : {}),
        ...(c.unreadCount > 0 ? { unread: true } : {}),
      },
    });
  }

  for (const m of msgs) {
    const chatName = names[m.conversationId] || NO_NAME;
    ranked.push({
      at: m.createdAt,
      result: {
        id: `m_${m.id}`,
        kind: 'message',
        title: chatName,
        subtitle: m.contentPlain,
        conversationId: m.conversationId,
        conversationName: chatName,
        ...(m.createdAt ? { time: timeLabel(m.createdAt) } : {}),
      },
    });
  }

  ranked.sort((a, b) => b.at - a.at);
  return ranked.map(r => r.result);
}

export function useSearch(query: string): {
  results: SearchResult[];
  frequent: FrequentChat[];
} {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [frequent, setFrequent] = useState<FrequentChat[]>([]);

  // Live "frequent" = most-recent conversations, straight from the DB (offline-first). The
  // subscription is owned here and disposed on unmount. Guarded so a missing native DB module
  // (pre-rebuild binary) degrades to an empty row instead of crashing the screen.
  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    try {
      sub = observeConversations(FREQUENT_LIMIT).subscribe(
        (rows: Conversation[]) => {
          setFrequent(
            rows.map(c => ({
              id: c.id,
              name: c.name ?? '',
            })),
          );
        },
      );
    } catch {
      setFrequent([]);
    }
    return () => sub?.unsubscribe();
  }, []);

  // Debounced search. Empty query → clear results (browse state) without touching the DB.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      runSearch(q)
        .then(next => {
          if (active) setResults(next);
        })
        .catch(() => {
          if (active) setResults([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  return { results, frequent };
}
