/**
 * A send is ONE fact, so it must be ONE transaction (§L6).
 *
 * The optimistic bubble and its outbox row used to be written by two independent transactions.
 * A process death between them — Android reclaiming memory on the 3 GB reference device, or the
 * second write simply throwing under disk pressure — leaves a message row stuck in `sending`
 * with nothing queued to transmit it. Crash recovery only repairs OUTBOX rows, so nothing ever
 * looks at that message again: it is never sent, and never surfaced as failed, so the bubble
 * keeps its clock icon across every relaunch with no retry affordance.
 *
 * The invariant this file pins down: after `enqueueOptimisticSend`, either BOTH rows exist or
 * NEITHER does.
 */
import { Q } from '@nozbe/watermelondb';
import { getDatabase } from '../database';
import { enqueueOptimisticSend, outboxStats } from '../outbox';
import { purgeAllLocalChat, upsertConversation } from '../queries';
import { Message } from '../models';

const convId = 'conv_atomic_1';
const meId = 'user_me';

async function messageCount(): Promise<number> {
  return getDatabase()
    .get<Message>('messages')
    .query(Q.where('conversation_id', convId))
    .fetchCount();
}

describe('enqueueOptimisticSend', () => {
  beforeEach(async () => {
    await purgeAllLocalChat();
    await upsertConversation(convId, {
      type: 'dm',
      name: 'Peer',
      lastMessagePreview: '',
      lastMessageAt: 0,
    });
  });

  it('writes the bubble and its outbox row together', async () => {
    const clientMsgId = await enqueueOptimisticSend(convId, 'hello', meId);

    expect(clientMsgId).toBeTruthy();
    expect(await messageCount()).toBe(1);
    const stats = await outboxStats();
    expect(stats.queued).toBe(1);
  });

  it('leaves NOTHING behind when the transaction fails', async () => {
    const db = getDatabase();
    const write = jest
      .spyOn(db, 'write')
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(enqueueOptimisticSend(convId, 'doomed', meId)).rejects.toThrow(
      'disk full',
    );

    write.mockRestore();
    // No orphaned bubble stuck in `sending` with no way to ever transmit or fail it.
    expect(await messageCount()).toBe(0);
    const stats = await outboxStats();
    expect(stats.queued).toBe(0);
  });

  it('refuses an empty message instead of queueing a blank send', async () => {
    expect(await enqueueOptimisticSend(convId, '   ', meId)).toBeNull();
    expect(await messageCount()).toBe(0);
    expect((await outboxStats()).queued).toBe(0);
  });

  it('refuses to queue a send with no sender identity', async () => {
    // The backend rejects a senderId that disagrees with the token, so a blank one would 4xx
    // forever. Failing here keeps a broken session from silently burning every retry.
    expect(await enqueueOptimisticSend(convId, 'hi', '')).toBeNull();
    expect(await messageCount()).toBe(0);
    expect((await outboxStats()).queued).toBe(0);
  });
});
