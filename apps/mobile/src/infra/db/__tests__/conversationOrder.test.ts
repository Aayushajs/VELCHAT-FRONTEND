/**
 * Catch-up order decides how long the app SAYS it is syncing (§29 — time to useful content).
 *
 * Reconnect walks the conversation list and backfills each one. Walked in storage order, the
 * first thing caught up is arbitrary — so the chat the user is about to open may be last, and the
 * "Syncing your messages…" banner describes work they do not care about. Most-recent-first makes
 * the first wave the conversations a user actually looks at.
 */
import {
  listConversationIds,
  upsertConversation,
  purgeAllLocalChat,
} from '../queries';

describe('listConversationIds', () => {
  beforeEach(async () => {
    await purgeAllLocalChat();
  });

  it('returns the most recently active conversations first', async () => {
    await upsertConversation('old', { type: 'dm', lastMessageAt: 1_000 });
    await upsertConversation('newest', { type: 'dm', lastMessageAt: 9_000 });
    await upsertConversation('mid', { type: 'dm', lastMessageAt: 5_000 });

    expect(await listConversationIds()).toEqual(['newest', 'mid', 'old']);
  });

  it('still lists conversations that have never carried a message', async () => {
    // A conversation with no messages is hidden from the CHAT LIST, but catch-up must still
    // visit it — that is exactly where a missed first message would be sitting.
    await upsertConversation('empty', { type: 'dm' });
    await upsertConversation('used', { type: 'dm', lastMessageAt: 4_000 });

    const ids = await listConversationIds();
    expect(ids).toContain('empty');
    expect(ids[0]).toBe('used'); // the one with activity is still prioritised
  });

  it('is empty on a fresh install rather than throwing', async () => {
    expect(await listConversationIds()).toEqual([]);
  });
});
