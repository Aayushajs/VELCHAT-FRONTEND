/**
 * The receipt can arrive before our own send is acknowledged (§F2).
 *
 * A message only learns its `seq` when the server's ack comes back. The peer, meanwhile, already
 * has the message — the fan-out reached them while our HTTP response was still in flight — so
 * their `delivered` can easily land first. Applied then, it matches nothing: our row has no seq
 * yet, and `applyReceipt` selects on `seq > 0`. The frame is gone, nothing re-applies it, and that
 * message keeps a single tick for the rest of its life however long the peer has had it.
 *
 * The peer's watermark is remembered for exactly this reason, so the fix is to re-apply it the
 * moment the row gains the seq it was missing.
 */
import { Q } from '@nozbe/watermelondb';
import { getDatabase } from '../database';
import { enqueueOptimisticSend } from '../outbox';
import { markMessageSent, applyReceipt } from '../messages';
import { purgeAllLocalChat, upsertConversation } from '../queries';
import {
  notePeerWatermark,
  getPeerWatermark,
  clearAllReceipts,
} from '../receiptStore';
import { Message } from '../models';
import { kv, KVKeys } from '../../kv';

const conv = 'conv_race';
const me = 'acct_me';

async function stateOf(clientMsgId: string): Promise<string | undefined> {
  const rows = await getDatabase()
    .get<Message>('messages')
    .query(Q.where('client_msg_id', clientMsgId))
    .fetch();
  return rows[0]?.state;
}

describe('a receipt that overtakes our own ack', () => {
  beforeEach(async () => {
    clearAllReceipts();
    await purgeAllLocalChat();
    kv.set(KVKeys.accountId, me);
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('is remembered even though it matches nothing yet', () => {
    notePeerWatermark(conv, { delivered: 5 });
    expect(getPeerWatermark(conv).delivered).toBe(5);
  });

  it('lifts the message as soon as the ack gives it a seq', async () => {
    const id = await enqueueOptimisticSend(conv, 'hi', me);
    // The peer already has it and says so, before our own ack comes back.
    notePeerWatermark(conv, { delivered: 5 });
    await applyReceipt(conv, 5, 'delivered');
    expect(await stateOf(id as string)).toBe('sending'); // nothing to match: no seq yet

    await markMessageSent(id as string, { messageId: 'srv', seq: 5 });
    expect(await stateOf(id as string)).toBe('sent');

    // Re-applying what the peer already told us is what turns the tick.
    const peer = getPeerWatermark(conv);
    await applyReceipt(conv, peer.delivered, 'delivered');
    expect(await stateOf(id as string)).toBe('delivered');
  });

  it('does not regress a message the peer has already read', async () => {
    const id = await enqueueOptimisticSend(conv, 'yo', me);
    await markMessageSent(id as string, { messageId: 'srv2', seq: 6 });
    await applyReceipt(conv, 6, 'read');
    await applyReceipt(conv, 6, 'delivered'); // a late/duplicate delivered
    expect(await stateOf(id as string)).toBe('read');
  });
});
