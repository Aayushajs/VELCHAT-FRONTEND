/**
 * The push runtime turns a button press on a notification into a real change, and it has to do
 * that correctly from a process that may have been started and killed since the press.
 *
 * Three properties are load-bearing and all three are encoded here:
 *
 *  1. **Exactly one handler per JS context.** The app's mount effect and the headless wake can
 *     both install it, and two subscriptions would each receive the same drained batch — i.e.
 *     every reply sent twice.
 *  2. **A reply goes through the ordinary send path AND marks the chat read**, because replying
 *     is reading and the user must not come back to their own reply under an unread badge.
 *  3. **The headless wake resolves only when the work is done**, including the outbox flush —
 *     returning early lets the OS tear the process down with the message still queued.
 *
 * Every shared binding below is `mock`-prefixed: `jest.mock` factories are hoisted above the
 * file's own declarations, and Babel refuses any other name to stop a factory closing over an
 * uninitialised variable.
 */
import type { PushPendingEvent } from '../../../infra';

const mockListeners = new Set<(e: PushPendingEvent) => void>();
const mockState: {
  queued: PushPendingEvent[];
  accountId: string | undefined;
  /** Milliseconds left on the access token. Large by default: no test needs a refresh. */
  accessTokenMs: number;
  refreshToken: string | undefined;
  /** What the outbox still holds AFTER a flush — drives the second-pass behaviour. */
  queuedAfterFlush: number;
} = {
  queued: [],
  accountId: 'me',
  accessTokenMs: 10 * 60_000,
  refreshToken: 'refresh-token',
  queuedAfterFlush: 0,
};

// Typed with a rest parameter so the mock factories below can forward `...unknown[]` into
// them; a zero-arg signature makes that spread a type error.
const mockSendText = jest.fn((..._a: unknown[]) => Promise.resolve(undefined));
const mockMarkRead = jest.fn((..._a: unknown[]) => Promise.resolve(undefined));
const mockFlushOutbox = jest.fn(async () => undefined);
const mockResyncNow = jest.fn(async () => undefined);
const mockSetPushAvailable = jest.fn();
const mockNoteInboundDelivered = jest.fn();
const mockInitPush = jest.fn(async () => undefined);
const mockSetNativeMute = jest.fn();
const mockRefreshSession = jest.fn(async () => ({ status: 'ok', access: 'fresh' }));
const mockSetConversationMute = jest.fn((..._a: unknown[]) =>
  Promise.resolve(undefined),
);

jest.mock('../../../infra', () => ({
  subscribePushEvents: (cb: (e: PushPendingEvent) => void) => {
    mockListeners.add(cb);
    return () => mockListeners.delete(cb);
  },
  subscribePushAvailability: (cb: (v: boolean) => void) => {
    cb(false);
    return () => undefined;
  },
  subscribePushMessages: () => () => undefined,
  subscribeSession: () => () => undefined,
  drainPendingEvents: async () => {
    // Mirrors the real contract: the queue is emptied by the read, and every listener in this
    // context receives the batch. Still the app's path — a live context applies actions as they
    // arrive rather than waiting for them.
    const batch = mockState.queued;
    mockState.queued = [];
    for (const event of batch) for (const l of mockListeners) l(event);
  },
  takeQueuedPushEvents: async () => {
    // The HEADLESS path takes the batch instead of pushing it through listeners, so the wake can
    // await each action and only resolve once the work is genuinely done. Same emptying contract.
    const batch = mockState.queued;
    mockState.queued = [];
    return batch;
  },
  initPush: () => mockInitPush(),
  unregisterPush: async () => undefined,
  setNativeMute: (...a: unknown[]) => mockSetNativeMute(...a),
  syncConversationNames: () => undefined,
  syncPersonNames: () => undefined,
  syncPersonAvatars: () => undefined,
  observeConversations: () => ({ subscribe: () => ({ unsubscribe() {} }) }),
  getAccountId: () => mockState.accountId,
  getRefreshToken: () => mockState.refreshToken,
  accessTokenExpiresInMs: () => mockState.accessTokenMs,
  refreshSession: () => mockRefreshSession(),
  outboxStats: async () => ({
    queued: mockState.queuedAfterFlush,
    nextDueAt: null,
  }),
}));

jest.mock('../../../domain/sync', () => ({
  syncEngine: {
    sendText: (...a: unknown[]) => mockSendText(...a),
    markConversationRead: (...a: unknown[]) => mockMarkRead(...a),
    flushOutboxNow: () => mockFlushOutbox(),
    resyncNow: () => mockResyncNow(),
    setPushAvailable: (...a: unknown[]) => mockSetPushAvailable(...a),
    noteInboundDelivered: (...a: unknown[]) => mockNoteInboundDelivered(...a),
  },
}));

jest.mock('../api/prefs', () => ({
  setConversationMute: (...a: unknown[]) => mockSetConversationMute(...a),
}));

jest.mock('../../../core', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Imported after the mocks so the module resolves them.
import {
  runQueuedPushActions,
  startPushRuntime,
  stopPushRuntime,
} from '../model/pushRuntime';

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  mockState.queued = [];
  mockState.accountId = 'me';
  mockState.accessTokenMs = 10 * 60_000;
  mockState.refreshToken = 'refresh-token';
  mockState.queuedAfterFlush = 0;
  stopPushRuntime();
});

afterEach(() => stopPushRuntime());

describe('pushRuntime — the wake window', () => {
  it('refreshes an expired access token BEFORE sending', async () => {
    // The bug this pins: the reply went out on a token that had already expired, so the wake
    // window paid 401 -> refresh -> retry. On mobile data that chain did not always finish, the
    // failure classified as transient — which pauses the whole outbox drain — and the reply left
    // only when the user next opened the app.
    mockState.accessTokenMs = 0;
    mockState.queued = [{ type: 'reply', conversationId: 'c1', text: 'hi' }];

    await runQueuedPushActions();

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a token with plenty of life left', async () => {
    mockState.queued = [{ type: 'reply', conversationId: 'c1', text: 'hi' }];
    await runQueuedPushActions();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it('does not try to refresh without a refresh token', async () => {
    // Signed out. There is nothing to refresh with, and asking would only waste the window.
    mockState.accessTokenMs = 0;
    mockState.refreshToken = undefined;
    await runQueuedPushActions();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it('flushes a second time when the outbox still holds work', async () => {
    // One transient failure pauses the drain, so a single flush can leave the reply behind. The
    // wake window is the only chance it gets before the next launch.
    mockState.queuedAfterFlush = 1;
    await runQueuedPushActions();
    expect(mockFlushOutbox).toHaveBeenCalledTimes(2);
  });

  it('flushes once when the outbox drained', async () => {
    mockState.queuedAfterFlush = 0;
    await runQueuedPushActions();
    expect(mockFlushOutbox).toHaveBeenCalledTimes(1);
  });
});

describe('pushRuntime — a queued reply', () => {
  it('sends it through the ordinary send path and marks the chat read', async () => {
    mockState.queued = [
      { type: 'reply', conversationId: 'c1', text: 'on my way' },
    ];
    await runQueuedPushActions();

    expect(mockSendText).toHaveBeenCalledWith('c1', 'me', 'on my way');
    // Replying is reading: the badge must not still be there when the user opens the chat.
    expect(mockMarkRead).toHaveBeenCalledWith('c1');
  });

  it('transmits before resolving — the process may be killed the moment we return', async () => {
    mockState.queued = [{ type: 'reply', conversationId: 'c1', text: 'hi' }];
    await runQueuedPushActions();

    expect(mockFlushOutbox).toHaveBeenCalledTimes(1);
    // The flush must come AFTER the send, or there is nothing in the outbox to transmit.
    expect(mockSendText.mock.invocationCallOrder[0] as number).toBeLessThan(
      mockFlushOutbox.mock.invocationCallOrder[0] as number,
    );
  });

  it('drops it when the account is gone, rather than sending as nobody', async () => {
    // Signed out between the tap and the drain. The server refuses a sender that disagrees with
    // the token, so sending anyway would strand the bubble as permanently failed.
    mockState.accountId = undefined;
    mockState.queued = [{ type: 'reply', conversationId: 'c1', text: 'hi' }];
    await runQueuedPushActions();

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('sends two replies once each, in order', async () => {
    mockState.queued = [
      { type: 'reply', conversationId: 'c1', text: 'first' },
      { type: 'reply', conversationId: 'c1', text: 'second' },
    ];
    await runQueuedPushActions();

    expect(mockSendText.mock.calls.map(c => (c as unknown[])[2])).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('pushRuntime — one handler per context', () => {
  it('does not double-send when both entry points install it', async () => {
    // The app's mount effect and the headless wake can genuinely coincide: native starts the
    // service when it sees no React context, and one can come alive in between.
    startPushRuntime();
    startPushRuntime();
    mockState.queued = [{ type: 'reply', conversationId: 'c1', text: 'hi' }];
    await runQueuedPushActions();

    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it('releases its subscription on stop (§M7)', () => {
    startPushRuntime();
    expect(mockListeners.size).toBe(1);
    stopPushRuntime();
    expect(mockListeners.size).toBe(0);
  });
});

describe('pushRuntime — the other queued actions', () => {
  it('applies a read locally (the receipt already went out natively)', async () => {
    mockState.queued = [{ type: 'read', conversationId: 'c1', upToSeq: 9 }];
    await runQueuedPushActions();
    expect(mockMarkRead).toHaveBeenCalledWith('c1');
  });

  it('writes a mute both natively and to the server pref', async () => {
    // The native mute silences THIS device now; the server pref is what stops the push being
    // sent at all. Neither alone is the whole behaviour.
    mockState.queued = [
      { type: 'mute', conversationId: 'c1', mutedUntil: 999 },
    ];
    await runQueuedPushActions();

    expect(mockSetNativeMute).toHaveBeenCalledWith('c1', 999);
    expect(mockSetConversationMute).toHaveBeenCalledWith('me', 'c1', 999);
  });

  it('keeps the native mute even when signed out', async () => {
    mockState.accountId = undefined;
    mockState.queued = [
      { type: 'mute', conversationId: 'c1', mutedUntil: 999 },
    ];
    await runQueuedPushActions();

    expect(mockSetNativeMute).toHaveBeenCalledWith('c1', 999);
    expect(mockSetConversationMute).not.toHaveBeenCalled();
  });

  it('re-registers when FCM rotated the token while JS was dead', async () => {
    mockState.queued = [{ type: 'token', token: 'fresh' }];
    await runQueuedPushActions();
    expect(mockInitPush).toHaveBeenCalled();
  });

  it('cursor-syncs when FCM reports it dropped messages', async () => {
    // There are no ids left to act on; a sync is the only thing that recovers them.
    mockState.queued = [{ type: 'resync' }];
    await runQueuedPushActions();
    expect(mockResyncNow).toHaveBeenCalled();
  });

  it('still applies the rest of the batch when one handler throws', async () => {
    mockSendText.mockRejectedValueOnce(new Error('offline'));
    mockState.queued = [
      { type: 'reply', conversationId: 'c1', text: 'hi' },
      { type: 'mute', conversationId: 'c2', mutedUntil: 5 },
    ];
    await expect(runQueuedPushActions()).resolves.toBeUndefined();
    expect(mockSetNativeMute).toHaveBeenCalledWith('c2', 5);
  });
});
