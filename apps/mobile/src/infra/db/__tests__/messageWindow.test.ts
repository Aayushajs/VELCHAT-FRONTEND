/**
 * "Load older" (§L7) — the chat must not simply END.
 *
 * The list loads a bounded window so a 100k-message conversation never materialises on the
 * render path. Bounded is correct; a dead end is not. Before this, scrolling up past ~50 bubbles
 * hit a wall with no trigger anywhere in the codebase that could load anything older — the rest
 * of the conversation was unreachable for the life of the install.
 */
import { Q } from '@nozbe/watermelondb';
import { getDatabase } from '../database';
import {
  applyServerMessages,
  minSeqForConversation,
  countMessages,
} from '../messages';
import { purgeAllLocalChat, upsertConversation } from '../queries';
import { Message } from '../models';
import type { ServerMessage } from '../../network/chat';

const convId = 'conv_window_1';

function serverMsg(seq: number): ServerMessage {
  return {
    messageId: `srv_${seq}`,
    conversationId: convId,
    seq,
    senderId: 'peer',
    type: 'text',
    content: `m${seq}`,
    serverTs: 1_700_000_000_000 + seq * 1000,
  };
}

/**
 * The window the chat renders, read through the same query `observeMessages` runs. (Its
 * observable emits asynchronously under the Loki test adapter, which would only measure the
 * adapter's scheduling, not the windowing contract this file is about.)
 */
async function windowSize(limit: number): Promise<number> {
  const rows = await getDatabase()
    .get<Message>('messages')
    .query(
      Q.where('conversation_id', convId),
      Q.where('deleted', false),
      Q.sortBy('created_at', Q.desc),
      Q.take(limit),
    )
    .fetch();
  return rows.length;
}

describe('the message window', () => {
  beforeEach(async () => {
    await purgeAllLocalChat();
    await upsertConversation(convId, { type: 'dm', name: 'Peer' });
    await applyServerMessages(
      Array.from({ length: 120 }, (_, i) => serverMsg(i + 1)),
    );
  });

  it('holds the full history locally but only renders a bounded slice', async () => {
    expect(await countMessages(convId)).toBe(120);
    expect(await windowSize(50)).toBe(50);
  });

  it('reveals older messages as the window grows', async () => {
    expect(await windowSize(100)).toBe(100);
    expect(await windowSize(200)).toBe(120); // never more than exists
  });

  it('renders the NEWEST slice, not the oldest', async () => {
    const rows = await getDatabase()
      .get<Message>('messages')
      .query(
        Q.where('conversation_id', convId),
        Q.sortBy('created_at', Q.desc),
        Q.take(1),
      )
      .fetch();
    expect(rows[0]?.seq).toBe(120);
  });

  it('reports the oldest seq held, which is the cursor for fetching further back', async () => {
    expect(await minSeqForConversation(convId)).toBe(1);
  });

  it('reports 0 for a conversation with no history, so paging cannot run off the end', async () => {
    expect(await minSeqForConversation('conv_empty')).toBe(0);
  });
});
