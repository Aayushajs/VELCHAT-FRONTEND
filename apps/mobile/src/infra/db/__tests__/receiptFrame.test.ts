/**
 * Inbound receipt frame parsing (§F2/§C5) — and the SELF-ECHO filter that makes ticks truthful.
 *
 * The realtime-gateway's fan-out (`fanout-consumer.onReceipt`) routes a receipt to EVERY member
 * of the conversation, INCLUDING the person who just acknowledged. `MessageReceiptPayload`
 * carries `user_id` = "the recipient who acknowledged" precisely so the receiver can tell whose
 * acknowledgement it is.
 *
 * Ignoring `user_id` means my OWN `read` receipt — emitted the moment I open a chat — comes
 * straight back to me and gets applied to my OWN sent messages, turning them blue because *I*
 * looked at the thread. The ticks then describe the reader's own behaviour instead of the peer's,
 * which is exactly "the tick status does not represent the actual delivery and read state".
 */
import { parseReceiptFrame } from '../receiptLedger';

const ME = 'acc-me';
const PEER = 'acc-peer';

describe('parseReceiptFrame', () => {
  it('accepts a snake_case frame from the peer (the wire shape)', () => {
    expect(
      parseReceiptFrame(
        { conversation_id: 'c1', up_to_seq: 12, user_id: PEER, state: 'read' },
        ME,
      ),
    ).toEqual({ conversationId: 'c1', upToSeq: 12, state: 'read' });
  });

  it('accepts a camelCase frame too (defensive against casing drift)', () => {
    expect(
      parseReceiptFrame(
        { conversationId: 'c1', upToSeq: 3, userId: PEER, state: 'delivered' },
        ME,
      ),
    ).toEqual({ conversationId: 'c1', upToSeq: 3, state: 'delivered' });
  });

  it('DROPS my own receipt echoed back by the fan-out', () => {
    expect(
      parseReceiptFrame(
        { conversation_id: 'c1', up_to_seq: 12, user_id: ME, state: 'read' },
        ME,
      ),
    ).toBeNull();
  });

  it('drops my own delivered echo as well', () => {
    expect(
      parseReceiptFrame(
        {
          conversation_id: 'c1',
          up_to_seq: 9,
          user_id: ME,
          state: 'delivered',
        },
        ME,
      ),
    ).toBeNull();
  });

  it('keeps a peer receipt when we do not know our own id (cannot be a self-echo we can prove)', () => {
    expect(
      parseReceiptFrame(
        { conversation_id: 'c1', up_to_seq: 4, user_id: PEER, state: 'read' },
        undefined,
      ),
    ).toEqual({ conversationId: 'c1', upToSeq: 4, state: 'read' });
  });

  it('tolerates a frame with no user_id (older gateway) rather than dropping a real receipt', () => {
    expect(
      parseReceiptFrame(
        { conversation_id: 'c1', up_to_seq: 4, state: 'read' },
        ME,
      ),
    ).toEqual({ conversationId: 'c1', upToSeq: 4, state: 'read' });
  });

  it('accepts a numeric string seq (envelope re-serialisation)', () => {
    expect(
      parseReceiptFrame(
        { conversation_id: 'c1', seq: '7', user_id: PEER, state: 'delivered' },
        ME,
      ),
    ).toEqual({ conversationId: 'c1', upToSeq: 7, state: 'delivered' });
  });

  it.each([
    ['no conversation id', { up_to_seq: 1, state: 'read' }],
    ['unknown state', { conversation_id: 'c1', up_to_seq: 1, state: 'seen' }],
    ['missing state', { conversation_id: 'c1', up_to_seq: 1 }],
    [
      'non-numeric seq',
      { conversation_id: 'c1', up_to_seq: 'x', state: 'read' },
    ],
    ['not an object', 'nope'],
    ['null', null],
  ])('rejects %s', (_label, frame) => {
    expect(parseReceiptFrame(frame, ME)).toBeNull();
  });
});
