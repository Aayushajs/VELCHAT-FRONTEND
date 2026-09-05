/**
 * `getAccountId()` must never come up empty while a session exists (§L14).
 *
 * It reads a value that is persisted only when the auth response happened to include it. When it
 * doesn't, callers reach for `getAccountId() ?? 'me'` — and `'me'` is catastrophic, because the
 * backend REFUSES a `senderId` that disagrees with the token (`actingAccountId`). Every send 4xxs
 * permanently, the user's own messages render as incoming bubbles, own messages bump the unread
 * badge, and no tick ever updates. All from one missing MMKV key.
 *
 * The access token already carries the answer in its `account_id` claim — it is the very value the
 * server will check against. Deriving it from there makes the whole failure mode unreachable.
 */
import { setTokens, clearSession, getAccountId } from '../tokens';
import { kv, KVKeys } from '../../kv';

/** Build an unsigned JWT with the given payload — only the payload is ever read client-side. */
function tokenWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/[/]/g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('getAccountId', () => {
  beforeEach(() => {
    clearSession();
    kv.delete(KVKeys.accountId);
  });

  it('prefers the persisted account id', () => {
    setTokens({
      access: tokenWith({ account_id: 'from-token' }),
      refresh: 'r',
      accountId: 'persisted',
    });
    expect(getAccountId()).toBe('persisted');
  });

  it('recovers the account id from the access token when it was never persisted', () => {
    setTokens({
      access: tokenWith({ account_id: 'acc-from-jwt' }),
      refresh: 'r',
    });
    expect(getAccountId()).toBe('acc-from-jwt');
  });

  it('persists the recovered id so later reads do not re-parse the token', () => {
    setTokens({
      access: tokenWith({ account_id: 'acc-from-jwt' }),
      refresh: 'r',
    });
    getAccountId();
    expect(kv.getString(KVKeys.accountId)).toBe('acc-from-jwt');
  });

  it('returns undefined rather than a wrong id when there is no session', () => {
    expect(getAccountId()).toBeUndefined();
  });

  it('returns undefined for a malformed token instead of guessing', () => {
    setTokens({ access: 'not-a-jwt', refresh: 'r' });
    expect(getAccountId()).toBeUndefined();
  });

  it('returns undefined when the token carries no account_id claim', () => {
    setTokens({ access: tokenWith({ device_id: 'd1' }), refresh: 'r' });
    expect(getAccountId()).toBeUndefined();
  });
});
