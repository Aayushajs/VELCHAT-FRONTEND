/**
 * Receipt ledger — the decision half of "why are the ticks wrong" (§F2/§C5).
 *
 * Receipts are CUMULATIVE (`up_to_seq` covers everything at or below it) and the gateway
 * silently drops inbound frames above ~40/sec per connection. Emitting one frame per message
 * is therefore both wasteful and self-defeating: a 100-message catch-up burst blows the budget
 * and takes the `read` and `sync` frames down with it. So the client tracks a WATERMARK per
 * conversation and emits at most one frame per state per flush.
 *
 * The other half is durability: a frame emitted while the socket is down is gone (the transport
 * drops silently when not OPEN), so "what we intend the peer to know" has to outlive the socket
 * and be re-emitted on reconnect. That is what `sent` vs `desired` models here.
 */
import {
  pendingReceiptFrames,
  mergeWatermark,
  type ReceiptWatermarks,
} from '../receiptLedger';

const wm = (delivered = 0, read = 0): ReceiptWatermarks => ({
  delivered,
  read,
});

describe('pendingReceiptFrames', () => {
  it('emits nothing when the peer already knows everything', () => {
    expect(pendingReceiptFrames(wm(10, 10), wm(10, 10))).toEqual([]);
  });

  it('emits one cumulative delivered frame, not one per message', () => {
    // 40 messages arrived while we were catching up; the peer needs ONE frame saying "…up to 40".
    expect(pendingReceiptFrames(wm(40, 0), wm(0, 0))).toEqual([
      { state: 'delivered', upToSeq: 40 },
    ]);
  });

  it('emits read on its own once the user opens the chat', () => {
    expect(pendingReceiptFrames(wm(40, 40), wm(40, 0))).toEqual([
      { state: 'read', upToSeq: 40 },
    ]);
  });

  it('skips a delivered frame that a read frame already implies', () => {
    // Read is strictly stronger than delivered, and both are cumulative: telling the peer
    // "read up to 40" makes "delivered up to 40" pure noise against the inbound budget.
    expect(pendingReceiptFrames(wm(40, 40), wm(0, 0))).toEqual([
      { state: 'read', upToSeq: 40 },
    ]);
  });

  it('still reports delivered for messages arrived beyond what was read', () => {
    // Chat is open at seq 40; 5 more land while the user is scrolled away from the bottom.
    expect(pendingReceiptFrames(wm(45, 40), wm(40, 40))).toEqual([
      { state: 'delivered', upToSeq: 45 },
    ]);
  });

  it('re-emits after a reconnect, because nothing confirmed the first attempt', () => {
    // The socket dropped before these went out: `sent` never advanced, so they are still pending.
    expect(pendingReceiptFrames(wm(90, 90), wm(12, 12))).toEqual([
      { state: 'read', upToSeq: 90 },
    ]);
  });

  it('never emits a frame that would move the peer backwards', () => {
    // A late/duplicated local update must not un-read a conversation.
    expect(pendingReceiptFrames(wm(5, 5), wm(40, 40))).toEqual([]);
  });
});

describe('mergeWatermark', () => {
  it('advances monotonically and ignores regressions', () => {
    expect(mergeWatermark(wm(10, 4), { delivered: 12 })).toEqual(wm(12, 4));
    expect(mergeWatermark(wm(10, 4), { delivered: 7 })).toEqual(wm(10, 4));
    expect(mergeWatermark(wm(10, 4), { read: 9 })).toEqual(wm(10, 9));
    expect(mergeWatermark(wm(10, 4), { read: 2 })).toEqual(wm(10, 4));
  });

  it('treats a read as proof of delivery', () => {
    // You cannot read what was not delivered; without this the client would announce a read
    // watermark ahead of its delivered one and then emit a pointless catch-up delivered frame.
    expect(mergeWatermark(wm(3, 0), { read: 9 })).toEqual(wm(9, 9));
  });

  it('ignores non-finite or negative input rather than corrupting the ledger', () => {
    expect(mergeWatermark(wm(10, 4), { delivered: Number.NaN })).toEqual(
      wm(10, 4),
    );
    expect(mergeWatermark(wm(10, 4), { read: -1 })).toEqual(wm(10, 4));
  });

  it('returns the same object when nothing changed, so callers can skip a write', () => {
    const before = wm(10, 4);
    expect(mergeWatermark(before, { delivered: 1 })).toBe(before);
  });
});
