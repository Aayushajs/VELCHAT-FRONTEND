/**
 * The session store must be OBSERVABLE (§L14 addendum).
 *
 * `hasSession()` is a bare MMKV read, so nothing downstream can learn that a session
 * appeared. The SyncEngine's `connect()` bails on `!hasSession()` and only re-arms on a
 * network/foreground transition — neither of which happens when the user signs in while
 * the app is already running. The result is an app that holds NO WebSocket for the rest of
 * the run: no inbound messages, no receipts (so no ticks), no presence. A restart "fixes"
 * it only because the session then exists before `start()` runs.
 *
 * These tests pin the notification contract that closes that hole.
 */
import { setTokens, clearSession, subscribeSession } from '../tokens';

jest.mock('../../kv', () => {
  const store = new Map<string, string | boolean | number>();
  return {
    kv: {
      getString: (k: string) => store.get(k) as string | undefined,
      getBoolean: (k: string) => store.get(k) as boolean | undefined,
      getNumber: (k: string) => store.get(k) as number | undefined,
      set: (k: string, v: string | boolean | number) => void store.set(k, v),
      delete: (k: string) => void store.delete(k),
      getAllKeys: () => [...store.keys()],
      clearAll: () => store.clear(),
    },
    KVKeys: {
      accessToken: 'auth.accessToken',
      refreshToken: 'auth.refreshToken',
      cnfJkt: 'auth.cnfJkt',
      deviceId: 'auth.deviceId',
      accountId: 'auth.accountId',
      tenantId: 'auth.tenantId',
      phone: 'auth.phone',
    },
  };
});

describe('session change notification', () => {
  afterEach(() => clearSession());

  it('notifies subscribers with true when a session is established', () => {
    const seen: boolean[] = [];
    const unsub = subscribeSession(s => seen.push(s));
    setTokens({ access: 'a.b.c', refresh: 'r', accountId: 'acc-1' });
    expect(seen).toEqual([true]);
    unsub();
  });

  it('notifies subscribers with false when the session is cleared', () => {
    setTokens({ access: 'a.b.c', refresh: 'r', accountId: 'acc-1' });
    const seen: boolean[] = [];
    const unsub = subscribeSession(s => seen.push(s));
    clearSession();
    expect(seen).toEqual([false]);
    unsub();
  });

  it('stops notifying after unsubscribe (§M7: every listener is disposable)', () => {
    const seen: boolean[] = [];
    subscribeSession(s => seen.push(s))();
    setTokens({ access: 'a.b.c', refresh: 'r', accountId: 'acc-1' });
    expect(seen).toEqual([]);
  });

  it('does not re-notify when the same session is written again', () => {
    setTokens({ access: 'a.b.c', refresh: 'r', accountId: 'acc-1' });
    const seen: boolean[] = [];
    const unsub = subscribeSession(s => seen.push(s));
    // A token REFRESH rewrites the same session; it must not look like a new sign-in,
    // or every refresh would re-trigger the whole post-login restore.
    setTokens({ access: 'a.b.c2', refresh: 'r2', accountId: 'acc-1' });
    expect(seen).toEqual([]);
    unsub();
  });

  it('one throwing subscriber cannot stop the others', () => {
    const seen: string[] = [];
    const u1 = subscribeSession(() => {
      throw new Error('boom');
    });
    const u2 = subscribeSession(() => seen.push('ok'));
    setTokens({ access: 'a.b.c', refresh: 'r', accountId: 'acc-1' });
    expect(seen).toEqual(['ok']);
    u1();
    u2();
  });
});
