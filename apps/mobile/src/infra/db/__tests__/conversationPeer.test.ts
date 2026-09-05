/**
 * The chat list must render WITHOUT touching the network (§M0 rules 2 + 3).
 *
 * Rendering one row used to require three REST calls — `/conversations/:id/members` for the peer,
 * then a profile, then a media URL — fired per row, per mount, per recycle. Fifty chats meant
 * roughly a hundred and fifty requests, so on a real connection the photos arrived late, in a
 * random order, or not at all ("photo kahin dikh raha kahin nahi"), and the list itself crawled.
 *
 * The inbox response ALREADY carries the member ids, so the peer is known at sync time for free.
 * Storing it — and the resolved photo — on the conversation row turns rendering into a pure local
 * read, which is the only way a list can be instant on a bad connection.
 */
import { upsertConversation } from '../queries';
import { purgeAllLocalChat } from '../queries';
import { getDatabase } from '../database';
import { Conversation } from '../models';

const convId = 'conv_peer_1';

async function row(): Promise<Conversation> {
  return getDatabase().get<Conversation>('conversations').find(convId);
}

describe('conversation row carries its peer identity', () => {
  beforeEach(async () => {
    await purgeAllLocalChat();
  });

  it('stores the peer account id resolved at sync time', async () => {
    await upsertConversation(convId, {
      type: 'dm',
      name: 'Sobha',
      peerId: 'acc_peer',
    });
    expect((await row()).peerId).toBe('acc_peer');
  });

  it('stores the peer photo so a row never fetches one while scrolling', async () => {
    await upsertConversation(convId, {
      type: 'dm',
      peerId: 'acc_peer',
      peerAvatarUrl: 'https://cdn.example/p.jpg',
    });
    expect((await row()).peerAvatarUrl).toBe('https://cdn.example/p.jpg');
  });

  it('keeps what it already knows when a later upsert omits those fields', async () => {
    // The message path upserts a conversation with only a preview; it must not erase the identity
    // the inbox sync resolved, or every incoming message would blank the photo again.
    await upsertConversation(convId, {
      type: 'dm',
      peerId: 'acc_peer',
      peerAvatarUrl: 'https://cdn.example/p.jpg',
    });
    await upsertConversation(convId, {
      lastMessagePreview: 'hi',
      lastMessageAt: 123,
    });
    const r = await row();
    expect(r.peerId).toBe('acc_peer');
    expect(r.peerAvatarUrl).toBe('https://cdn.example/p.jpg');
    expect(r.lastMessagePreview).toBe('hi');
  });

  it('lets a refreshed photo replace a stale one', async () => {
    await upsertConversation(convId, {
      type: 'dm',
      peerAvatarUrl: 'https://cdn.example/old.jpg',
    });
    await upsertConversation(convId, {
      peerAvatarUrl: 'https://cdn.example/new.jpg',
    });
    expect((await row()).peerAvatarUrl).toBe('https://cdn.example/new.jpg');
  });

  it('surfaces the identity through the query the list observes', async () => {
    await upsertConversation(convId, {
      type: 'dm',
      name: 'Sobha',
      peerId: 'acc_peer',
      peerAvatarUrl: 'https://cdn.example/p.jpg',
      lastMessagePreview: 'hi',
      lastMessageAt: Date.now(),
    });
    // Read the query directly: its observable emits asynchronously under the Loki test adapter,
    // which would measure the adapter's scheduling rather than what the list actually receives.
    const rows = await getDatabase()
      .get<Conversation>('conversations')
      .query()
      .fetch();
    const found = rows.find(r => r.id === convId);
    expect(found?.peerId).toBe('acc_peer');
    expect(found?.peerAvatarUrl).toBe('https://cdn.example/p.jpg');
  });
});
