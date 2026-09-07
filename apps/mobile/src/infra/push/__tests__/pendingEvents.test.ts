/**
 * The notification-action queue crosses a native → JS boundary that is untyped in both
 * directions, and `takePendingEvents` EMPTIES the native queue as it reads it — so there is
 * nothing to retry against and a parsing mistake costs the user's action outright.
 *
 * These tests encode the two rules that follow from that: reject anything that cannot be acted
 * on safely, and never merge two replies (they are two messages, and dropping or reordering one
 * is a message-correctness bug, not a cosmetic one).
 */
import {
  collapsePendingEvents,
  parsePendingEvent,
  parsePendingEvents,
} from '../pendingEvents';
import type { PushPendingEvent } from '../types';

describe('parsePendingEvent', () => {
  it('parses a reply', () => {
    expect(
      parsePendingEvent({
        type: 'reply',
        conversationId: 'c1',
        text: 'on my way',
        upToSeq: 12,
        at: 1700000000000,
      }),
    ).toEqual({
      type: 'reply',
      conversationId: 'c1',
      text: 'on my way',
      upToSeq: 12,
      at: 1700000000000,
    });
  });

  it('trims a reply rather than sending the surrounding whitespace', () => {
    expect(
      parsePendingEvent({
        type: 'reply',
        conversationId: 'c1',
        text: '  hi  ',
      }),
    ).toEqual({ type: 'reply', conversationId: 'c1', text: 'hi' });
  });

  it('drops a whitespace-only reply — that is a mis-tap, not a message', () => {
    expect(
      parsePendingEvent({ type: 'reply', conversationId: 'c1', text: '   ' }),
    ).toBeNull();
  });

  it('drops a reply with no conversation', () => {
    expect(parsePendingEvent({ type: 'reply', text: 'hi' })).toBeNull();
  });

  it('omits an absent optional rather than setting it to undefined', () => {
    // `exactOptionalPropertyTypes` distinguishes the two, and a caller doing `'upToSeq' in e`
    // must not see a key that was never sent.
    const parsed = parsePendingEvent({
      type: 'reply',
      conversationId: 'c1',
      text: 'hi',
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as object).sort()).toEqual([
      'conversationId',
      'text',
      'type',
    ]);
  });

  it('accepts a numeric seq that arrived as a string', () => {
    expect(
      parsePendingEvent({ type: 'read', conversationId: 'c1', upToSeq: '9' }),
    ).toEqual({ type: 'read', conversationId: 'c1', upToSeq: 9 });
  });

  it.each([0, -1, 'later', Number.NaN, Number.POSITIVE_INFINITY, null])(
    'drops an unusable seq (%p) instead of letting NaN reach a watermark',
    bad => {
      const parsed = parsePendingEvent({
        type: 'read',
        conversationId: 'c1',
        upToSeq: bad,
      });
      // The read itself still stands — it clears the badge — but with no seq at all.
      expect(parsed).toEqual({ type: 'read', conversationId: 'c1' });
    },
  );

  it('requires a mute to carry its expiry', () => {
    expect(
      parsePendingEvent({ type: 'mute', conversationId: 'c1' }),
    ).toBeNull();
    expect(
      parsePendingEvent({
        type: 'mute',
        conversationId: 'c1',
        mutedUntil: 1700000000000,
      }),
    ).toEqual({
      type: 'mute',
      conversationId: 'c1',
      mutedUntil: 1700000000000,
    });
  });

  it('parses token and resync', () => {
    expect(parsePendingEvent({ type: 'token', token: 'abc' })).toEqual({
      type: 'token',
      token: 'abc',
    });
    expect(parsePendingEvent({ type: 'resync' })).toEqual({ type: 'resync' });
    expect(parsePendingEvent({ type: 'token', token: '' })).toBeNull();
  });

  it('drops a type this bundle does not model', () => {
    // A newer native build queued something we cannot read. Acting on an unknown shape is how a
    // "reply" ends up in the wrong conversation.
    expect(
      parsePendingEvent({ type: 'reaction', conversationId: 'c1' }),
    ).toBeNull();
  });

  it.each([null, undefined, 'reply', 42, []])('drops %p', bad => {
    expect(parsePendingEvent(bad)).toBeNull();
  });
});

describe('parsePendingEvents', () => {
  it('keeps the good entries and discards the rest', () => {
    expect(
      parsePendingEvents([
        { type: 'reply', conversationId: 'c1', text: 'a' },
        { type: 'reply', conversationId: '', text: 'b' },
        null,
        { type: 'resync' },
      ]),
    ).toEqual([
      { type: 'reply', conversationId: 'c1', text: 'a' },
      { type: 'resync' },
    ]);
  });

  it('returns empty for a non-array', () => {
    expect(parsePendingEvents({ type: 'resync' })).toEqual([]);
  });
});

describe('collapsePendingEvents', () => {
  it('NEVER merges two replies, and keeps their order', () => {
    // Two inline replies are two messages. Merging or reordering them is a visible corruption.
    const events: PushPendingEvent[] = [
      { type: 'reply', conversationId: 'c1', text: 'first' },
      { type: 'reply', conversationId: 'c1', text: 'second' },
    ];
    expect(collapsePendingEvents(events)).toEqual(events);
  });

  it('keeps only the highest read watermark per conversation', () => {
    const out = collapsePendingEvents([
      { type: 'read', conversationId: 'c1', upToSeq: 5 },
      { type: 'read', conversationId: 'c1', upToSeq: 9 },
      { type: 'read', conversationId: 'c1', upToSeq: 7 },
      { type: 'read', conversationId: 'c2', upToSeq: 2 },
    ]);
    expect(out).toEqual([
      { type: 'read', conversationId: 'c1', upToSeq: 9 },
      { type: 'read', conversationId: 'c2', upToSeq: 2 },
    ]);
  });

  it("folds a reply's implied read into the conversation's read watermark", () => {
    const out = collapsePendingEvents([
      { type: 'read', conversationId: 'c1', upToSeq: 3 },
      { type: 'reply', conversationId: 'c1', text: 'ok', upToSeq: 8 },
    ]);
    expect(out).toEqual([
      { type: 'reply', conversationId: 'c1', text: 'ok', upToSeq: 8 },
      { type: 'read', conversationId: 'c1', upToSeq: 8 },
    ]);
  });

  it('keeps a seq-less read, because it still has to clear the local badge', () => {
    expect(
      collapsePendingEvents([{ type: 'read', conversationId: 'c1' }]),
    ).toEqual([{ type: 'read', conversationId: 'c1' }]);
  });

  it('does not let a seq-less read erase a real watermark', () => {
    expect(
      collapsePendingEvents([
        { type: 'read', conversationId: 'c1', upToSeq: 4 },
        { type: 'read', conversationId: 'c1' },
      ]),
    ).toEqual([{ type: 'read', conversationId: 'c1', upToSeq: 4 }]);
  });

  it('keeps the latest mute per conversation', () => {
    expect(
      collapsePendingEvents([
        { type: 'mute', conversationId: 'c1', mutedUntil: 100 },
        { type: 'mute', conversationId: 'c1', mutedUntil: 900 },
      ]),
    ).toEqual([{ type: 'mute', conversationId: 'c1', mutedUntil: 900 }]);
  });

  it('keeps only the newest token — older ones are already dead', () => {
    const out = collapsePendingEvents([
      { type: 'token', token: 'old' },
      { type: 'token', token: 'new' },
    ]);
    expect(out).toEqual([{ type: 'token', token: 'new' }]);
  });

  it('collapses repeated resyncs to one', () => {
    expect(
      collapsePendingEvents([{ type: 'resync' }, { type: 'resync' }]),
    ).toEqual([{ type: 'resync' }]);
  });

  it('puts replies before everything else so the send is not queued behind housekeeping', () => {
    const out = collapsePendingEvents([
      { type: 'resync' },
      { type: 'mute', conversationId: 'c2', mutedUntil: 5 },
      { type: 'reply', conversationId: 'c1', text: 'hi' },
    ]);
    expect(out[0]).toEqual({ type: 'reply', conversationId: 'c1', text: 'hi' });
  });

  it('is a no-op on an empty batch', () => {
    expect(collapsePendingEvents([])).toEqual([]);
  });
});
