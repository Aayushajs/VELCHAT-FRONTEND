/**
 * Observe a conversation's messages from the local DB + send optimistically (§F2/§L7).
 * The UI never waits on the network: a send writes to the DB and the list re-renders at
 * once; the MP2 outbox transmits + reconciles later.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { observeMessages, getAccountId, Message } from '../../../infra';
import { syncEngine } from '../../../domain/sync';

export function useMessages(conversationId: string): {
  messages: Message[];
  meId: string;
} {
  const meId = useMemo(() => getAccountId() ?? 'me', []);
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    // Opening the chat = read it: clear the unread badge locally + tell the server (§F2).
    // Telling the engine this chat is ON SCREEN is what keeps that true for messages that arrive
    // WHILE it is open — otherwise the badge climbs on the conversation the user is reading and
    // the sender's ticks never turn blue, because the read was only ever reported once, at mount.
    syncEngine.setActiveConversation(conversationId);
    void syncEngine.markConversationRead(conversationId);
    let sub: { unsubscribe: () => void } | undefined;
    try {
      sub = observeMessages(conversationId).subscribe(setMessages);
    } catch {
      setMessages([]);
    }
    return () => {
      sub?.unsubscribe();
      syncEngine.setActiveConversation(null);
    };
  }, [conversationId, meId]);
  return { messages, meId };
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
