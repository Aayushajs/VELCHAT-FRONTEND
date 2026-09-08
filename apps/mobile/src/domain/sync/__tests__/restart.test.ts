/**
 * The engine must reconnect after a stop/start cycle (§L6/§M8).
 *
 * `startSync`/`stopSync` bracket the authenticated session, so a sign-out followed by a sign-in
 * — without killing the app — is exactly a stop/start. The engine only opens a socket on a
 * connectivity TRANSITION, so it must not remember the connectivity of the session that ended:
 * a stale "we were online" makes the seed on the next start look like no change at all, and the
 * app spends the entire rest of the run with no WebSocket — no inbound messages, no ticks, no
 * presence. Force-quitting the app appears to fix it, which is what makes it so confusing.
 */
const mockSockets: { connected: boolean }[] = [];

jest.mock('../../../infra/realtime/socket', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../../../infra/realtime/socket',
  );
  class FakeSocket {
    open = false;
    get isActive(): boolean {
      return this.open;
    }
    connect(): void {
      this.open = true;
      mockSockets.push({ connected: true });
    }
    send(): boolean {
      return true;
    }
    sendEphemeral(): boolean {
      return true;
    }
    close(): void {
      this.open = false;
    }
  }
  return { ...actual, RealtimeSocket: FakeSocket };
});

import { syncEngine } from '../SyncEngine';
import { kv, KVKeys } from '../../../infra/kv';

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (mockSockets.length > 0) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('stop → start', () => {
  beforeEach(() => {
    mockSockets.length = 0;
    kv.clearAll();
    kv.set(KVKeys.accessToken, 'test.access.token');
    kv.set(KVKeys.accountId, 'acct_me');
  });

  afterEach(() => {
    syncEngine.stop();
  });

  it('opens a socket on the first start', async () => {
    syncEngine.start();
    await settle();
    expect(mockSockets).toHaveLength(1);
  });

  it('opens a socket AGAIN after a stop — a re-login must not run without realtime', async () => {
    syncEngine.start();
    await settle();
    syncEngine.stop();

    mockSockets.length = 0;
    syncEngine.start();
    await settle();

    expect(mockSockets).toHaveLength(1);
  });
});
