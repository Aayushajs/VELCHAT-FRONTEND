/**
 * After a reconnect, what the peer actually received is unknowable — so re-assert it.
 *
 * The ledger records what it has "sent" so the same receipt is not emitted forever. But
 * `socket.send()` returning true only means the transport accepted the frame; it says nothing
 * about the peer ever seeing it. During the outage where the server accepted receipts and fanned
 * out nothing, every client dutifully recorded them as sent — and then never sent them again. The
 * result outlives the outage: those messages are stuck on one tick permanently, because the only
 * client that could correct them has decided the work is done.
 *
 * A reconnect is exactly the moment that assumption is worthless, so the sent watermarks are
 * dropped and the current state is announced again. The cost is one frame per conversation per
 * reconnect; the alternative is a tick that can never heal.
 */
import {
  noteDesired,
  noteSent,
  getSent,
  getDesired,
  reassertReceipts,
  clearAllReceipts,
} from '../receiptStore';

describe('reassertReceipts', () => {
  beforeEach(() => {
    clearAllReceipts();
  });

  it('re-offers receipts the peer may never have received', () => {
    noteDesired('c1', { delivered: 12 });
    noteSent('c1', { delivered: 12 }); // believed delivered — possibly never fanned out

    const ids = reassertReceipts();

    expect(ids).toContain('c1');
    expect(getSent('c1')).toEqual({ delivered: 0, read: 0 });
    // What we WANT the peer to know is untouched — only our belief about them is discarded.
    expect(getDesired('c1')).toEqual({ delivered: 12, read: 0 });
  });

  it('returns every conversation that owes something', () => {
    noteDesired('c1', { delivered: 3 });
    noteDesired('c2', { read: 9 });
    expect(reassertReceipts().sort()).toEqual(['c1', 'c2']);
  });

  it('ignores conversations with nothing to say', () => {
    expect(reassertReceipts()).toEqual([]);
  });

  it('is safe to run twice', () => {
    noteDesired('c1', { read: 4 });
    reassertReceipts();
    expect(reassertReceipts()).toContain('c1');
    expect(getDesired('c1').read).toBe(4);
  });
});
