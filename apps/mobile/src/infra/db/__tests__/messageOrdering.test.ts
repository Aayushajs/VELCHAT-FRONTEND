/**
 * Where a message SITS in the list after it finally sends (§L7).
 *
 * The list is ordered by `created_at`, which is stamped when the user hits send. For an online
 * send those are the same instant, so nothing looks wrong. For a message composed offline they
 * are hours apart: the bubble stays pinned at its COMPOSE time, buried under every message that
 * arrived while the phone had no signal — under a stale date separator, and, once more than a
 * window's worth arrived in between, outside the loaded window entirely. To the user who typed
 * it, their message simply vanished.
 *
 * The server timestamp is the one everyone else orders by, so on ack that is what the row must
 * carry.
 */
import { Q } from '@nozbe/watermelondb';
import { getDatabase } from '../database';
import { enqueueOptimisticSend } from '../outbox';
import { markMessageSent } from '../messages';
import { purgeAllLocalChat, upsertConversation } from '../queries';
import { Message } from '../models';

const convId = 'conv_order_1';
const meId = 'user_me';

async function rowFor(clientMsgId: string): Promise<Message | undefined> {
  const rows = await getDatabase()
    .get<Message>('messages')
    .query(Q.where('client_msg_id', clientMsgId))
    .fetch();
  return rows[0];
}

describe('a send that leaves the outbox hours later', () => {
  beforeEach(async () => {
    await purgeAllLocalChat();
    await upsertConversation(convId, {
      type: 'dm',
      name: 'Peer',
      lastMessagePreview: '',
      lastMessageAt: 0,
    });
  });

  it('takes its position from the server clock, not from when it was typed', async () => {
    const clientMsgId = await enqueueOptimisticSend(convId, 'omw', meId);
    expect(clientMsgId).toBeTruthy();
    const composedAt = (await rowFor(clientMsgId as string))
      ?.createdAt as number;

    // Four hours in a tunnel, then it finally transmits.
    const serverTs = composedAt + 4 * 60 * 60 * 1000;
    await markMessageSent(clientMsgId as string, {
      messageId: 'srv1',
      seq: 900,
      serverTs,
    });

    const row = await rowFor(clientMsgId as string);
    expect(row?.seq).toBe(900);
    expect(row?.state).toBe('sent');
    // Ordered with everything else that happened at 14:00, not stranded back at 10:00.
    expect(row?.createdAt).toBe(serverTs);
  });

  it('keeps the compose time when the server did not send one', async () => {
    const clientMsgId = await enqueueOptimisticSend(convId, 'hi', meId);
    const composedAt = (await rowFor(clientMsgId as string))?.createdAt;

    await markMessageSent(clientMsgId as string, { messageId: 'srv2', seq: 5 });

    expect((await rowFor(clientMsgId as string))?.createdAt).toBe(composedAt);
  });

  it('never drags a message backwards in time', async () => {
    // A clock-skewed server timestamp older than the compose time would re-bury the bubble.
    const clientMsgId = await enqueueOptimisticSend(convId, 'yo', meId);
    const composedAt = (await rowFor(clientMsgId as string))
      ?.createdAt as number;

    await markMessageSent(clientMsgId as string, {
      messageId: 'srv3',
      seq: 7,
      serverTs: composedAt - 60_000,
    });

    expect((await rowFor(clientMsgId as string))?.createdAt).toBe(composedAt);
  });
});
