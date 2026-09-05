/**
 * Observe a conversation's messages from the local DB + send optimistically (§F2/§L7).
 * The UI never waits on the network: a send writes to the DB and the list re-renders at
 * once; the MP2 outbox transmits + reconciles later.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  observeMessages,
  getAccountId,
  countMessages,
  MESSAGE_PAGE,
  Message,
} from '../../../infra';
import { syncEngine } from '../../../domain/sync';

export function useMessages(conversationId: string): {
  messages: Message[];
  meId: string;
  /** Reveal the previous page of history — call when the user scrolls past the oldest bubble. */
  loadOlder: () => void;
} {
  const meId = useMemo(() => getAccountId() ?? 'me', []);
  const [messages, setMessages] = useState<Message[]>([]);
  // The window grows; it never shrinks while the chat is open, so scrolling back up does not
  // re-drop history the user just pulled in.
  const [limit, setLimit] = useState(MESSAGE_PAGE);
  const loadingOlder = useRef(false);

  useEffect(() => {
    setLimit(MESSAGE_PAGE); // a different conversation starts from one page again
  }, [conversationId]);

  /**
   * Grow the local window, and only when the DB has no more to give, reach back to the server.
   * Without this the list simply ENDED at 50 bubbles — scrolling up in a long chat hit a wall
   * with no way to ever see anything older.
   */
  const loadOlder = useCallback(() => {
    if (loadingOlder.current) return;
    loadingOlder.current = true;
    void (async () => {
      try {
        const held = await countMessages(conversationId);
        if (held > limit) {
          setLimit(l => l + MESSAGE_PAGE); // still paging through what we already hold
          return;
        }
        const grew = await syncEngine.loadOlderMessages(
          conversationId,
          MESSAGE_PAGE,
        );
        if (grew) setLimit(l => l + MESSAGE_PAGE);
      } catch {
        // Offline or the server has nothing older — the window simply stays where it is.
      } finally {
        loadingOlder.current = false;
      }
    })();
  }, [conversationId, limit]);

  useEffect(() => {
    // Opening the chat = read it: clear the unread badge locally + tell the server (§F2).
    // Telling the engine this chat is ON SCREEN is what keeps that true for messages that arrive
    // WHILE it is open — otherwise the badge climbs on the conversation the user is reading and
    // the sender's ticks never turn blue, because the read was only ever reported once, at mount.
    syncEngine.setActiveConversation(conversationId);
    void syncEngine.markConversationRead(conversationId);
    let sub: { unsubscribe: () => void } | undefined;
    try {
      sub = observeMessages(conversationId, limit).subscribe(setMessages);
    } catch {
      setMessages([]);
    }
    return () => {
      sub?.unsubscribe();
      syncEngine.setActiveConversation(null);
    };
  }, [conversationId, meId, limit]);
  return { messages, meId, loadOlder };
}

/** Retry a permanently-failed send (tapped from the bubble) — re-queues the same message. */
export function useRetrySend(): (clientMsgId: string) => void {
  return useCallback((clientMsgId: string) => {
    void syncEngine.retrySend(clientMsgId);
  }, []);
}

export function useSendMessage(conversationId: string): (text: string) => void {
  const meId = useMemo(() => getAccountId() ?? 'me', []);
  return useCallback(
    (text: string) => {
      // Fire-and-forget: the engine writes the optimistic bubble to the DB (instant UI),
      // enqueues the durable outbox item, and transmits off the render path (§L6/§L7).
      void syncEngine.sendText(conversationId, meId, text);
    },
    [conversationId, meId],
  );
}
