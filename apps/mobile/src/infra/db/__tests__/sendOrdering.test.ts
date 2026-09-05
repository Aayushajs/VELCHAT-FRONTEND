/**
 * Two messages fired in the same millisecond must still leave in the order they were typed (§L6).
 *
 * "omw" then "5 min" is one thought in two bubbles, and on a fast device both `Date.now()` stamps
 * are identical. The queue ordered by that stamp, and picked the head of a conversation by
 * comparing equality against it — so BOTH rows qualified as head-of-line and which one went first
 * came down to SQLite's fetch order. They transmit in that order, get their seqs in that order,
 * and the peer reads the reply before the message. The list has the same problem: it orders by the
 * same non-unique key.
 */
import { enqueueOptimisticSend, claimNextDue, markAckd } from '../outbox';
import { purgeAllLocalChat, upsertConversation } from '../queries';

const convId = 'conv_order_race';
const meId = 'user_me';

describe('two sends in the same millisecond', () => {
  beforeEach(async () => {
    await purgeAllLocalChat();
    await upsertConversation(convId, { type: 'dm', name: 'Peer' });
  });

  it('transmits them in the order they were composed', async () => {
    // Freeze the clock: every stamp below would otherwise be identical anyway on a fast device.
    const now = 1_800_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await enqueueOptimisticSend(convId, 'omw', meId);
      await enqueueOptimisticSend(convId, '5 min', meId);
      await enqueueOptimisticSend(convId, 'wait outside', meId);

      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        const item = await claimNextDue(now);
        expect(item).not.toBeNull();
        order.push(String(item?.input.content ?? ''));
        await markAckd(item?.id as string);
      }
      expect(order).toEqual(['omw', '5 min', 'wait outside']);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives each message a strictly increasing position, so the list cannot invert them', async () => {
    const now = 1_800_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await enqueueOptimisticSend(convId, 'first', meId);
      await enqueueOptimisticSend(convId, 'second', meId);
      const a = await claimNextDue(now);
      await markAckd(a?.id as string);
      const b = await claimNextDue(now);
      expect(a?.input.content).toBe('first');
      expect(b?.input.content).toBe('second');
    } finally {
      spy.mockRestore();
    }
  });
});
