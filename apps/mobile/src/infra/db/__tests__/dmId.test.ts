/**
 * Client-side DM conversation id (§B7) — the offline New-Chat fix.
 *
 * `POST /conversations/dm` is IDEMPOTENT and returns a DETERMINISTIC id derived purely from the
 * member pair, so the client can compute the same id without a round-trip and open the chat
 * instantly (even offline / on a brand-new contact). The server call still happens — it creates
 * the row and, critically, seeds the realtime membership projection that message fan-out needs —
 * but it no longer sits between the tap and the chat screen.
 *
 * That only holds if this port is EXACT. These are known-answer vectors computed with
 * `node:crypto` straight from the backend's `libs/feature-group-channel/src/channels/dm-id.ts`:
 *
 *   dmConversationId(a, b) = 'dm-' + sha256(`${x}|${y}`).hex.slice(0, 32),  [x,y] = [a,b].sort()
 *
 * A divergence here would fork every thread into a local id the server never uses.
 */
import { dmConversationId } from '../dmId';

describe('dmConversationId', () => {
  it.each([
    ['acc-a', 'acc-b', 'dm-2d32a584f6d9e47381793dac3b9519c6'],
    [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'dm-e6d2212955f55a4e9ce2af8fb18e4153',
    ],
    ['zzz', 'aaa', 'dm-59453a38cd887c40a86e2e92a0f00875'],
  ])('matches the backend for (%s, %s)', (a, b, expected) => {
    expect(dmConversationId(a, b)).toBe(expected);
  });

  it('is order-independent — both users derive the SAME thread', () => {
    expect(dmConversationId('acc-a', 'acc-b')).toBe(
      dmConversationId('acc-b', 'acc-a'),
    );
    expect(dmConversationId('acc-b', 'acc-a')).toBe(
      'dm-2d32a584f6d9e47381793dac3b9519c6',
    );
  });

  it('supports note-to-self (a === b), as the backend does', () => {
    expect(dmConversationId('same', 'same')).toBe(
      'dm-c381e96e51f269964d8a3c1ccb3175df',
    );
  });

  it('always yields the dm- prefix and 32 hex chars', () => {
    const id = dmConversationId('user-x', 'user-y');
    expect(id).toMatch(/^dm-[0-9a-f]{32}$/);
  });

  it('is stable across repeated calls', () => {
    expect(dmConversationId('p', 'q')).toBe(dmConversationId('p', 'q'));
  });

  it('rejects a blank id rather than inventing a shared bogus thread', () => {
    expect(() => dmConversationId('', 'acc-b')).toThrow();
    expect(() => dmConversationId('acc-a', '  ')).toThrow();
  });
});
