/**
 * §R2 failure scenarios, driven through the REAL SyncEngine (§L6/§M8).
 *
 * These are the behaviours that break messaging apps in production and that a unit test of a
 * pure helper cannot reach: the engine's wiring between the socket, the REST backfill, the
 * outbox drain and the local DB. Only three seams are faked — the WebSocket, the two chat REST
 * calls, and connectivity. Everything else (WatermelonDB via the Loki adapter, the outbox, the
 * reconcile, the receipt ledger, the token store) is the shipping code.
 *
 * Loki caveat: WatermelonDB observables emit asynchronously under the test adapter, so these
 * read the queries directly (as messageWindow.test.ts / conversationPeer.test.ts do) and poll
 * with `until()` for the engine's fire-and-forget work rather than subscribing.
 */
import { Q } from '@nozbe/watermelondb';
import type { RealtimeSocketCallbacks } from '../../../infra/realtime/socket';
import type {
  ServerMessage,
  SendAck,
  SendMessageInput,
} from '../../../infra/network/chat';

// ── seams ────────────────────────────────────────────────────────────────────

interface SentFrame {
  readonly type: string;
  readonly data: unknown;
}

/** The structural surface of the socket the engine drives, plus a test-only `drop()`. */
interface MockSocket {
  readonly sent: SentFrame[];
  open: boolean;
  readonly cb: RealtimeSocketCallbacks;
  /** Simulate a NON-intentional close (network drop / server kill). */
  drop(code: number, reason: string): void;
}

const mockSockets: MockSocket[] = [];

jest.mock('../../../infra/realtime/socket', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../../../infra/realtime/socket',
  );
  class FakeSocket {
    readonly sent: SentFrame[] = [];
    open = false;
    // Declared explicitly rather than via a constructor parameter property: Babel's jest.mock
    // hoisting check reads the transformed shorthand as an out-of-scope reference and refuses
    // the whole factory.
    readonly cb: RealtimeSocketCallbacks;
    constructor(cb: RealtimeSocketCallbacks) {
      this.cb = cb;
      mockSockets.push(this);
    }
    get isActive(): boolean {
      return this.open;
    }
    connect(): void {
      this.open = true;
      this.cb.onOpen?.();
    }
    send(type: string, data: unknown): boolean {
      if (!this.open) return false;
      this.sent.push({ type, data });
      return true;
    }
    sendEphemeral(type: string, fields: Record<string, unknown>): boolean {
      if (!this.open) return false;
      this.sent.push({ type, data: fields });
      return true;
    }
    close(): void {
      this.open = false;
    }
    drop(code: number, reason: string): void {
      this.open = false;
      this.cb.onClose?.(code, reason);
    }
  }
  return { ...actual, RealtimeSocket: FakeSocket };
});

const mockFetchAfter: jest.Mock = jest.fn();
const mockSendChat: jest.Mock = jest.fn();

jest.mock('../../../infra/network/chat', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../../../infra/network/chat',
  );
  return {
    ...actual,
    fetchMessagesAfter: (
      conversationId: string,
      afterSeq: number,
      limit?: number,
    ): Promise<ServerMessage[]> =>
      mockFetchAfter(conversationId, afterSeq, limit) as Promise<
        ServerMessage[]
      >,
    sendChatMessage: (input: SendMessageInput): Promise<SendAck> =>
      mockSendChat(input) as Promise<SendAck>,
    fetchPeerReceipts: (conversationId: string): Promise<unknown[]> =>
      Promise.resolve(mockServerReceipts.get(conversationId) ?? []),
  };
});

/**
 * What the DURABLE receipt store holds, per conversation — the answer a client gets when it asks
 * the server instead of waiting for a socket frame that may never come.
 */
const mockServerReceipts = new Map<
  string,
  { userId: string; state: 'delivered' | 'read'; upToSeq: number }[]
>();

interface NetSnapshot {
  isConnected: boolean;
  type: string;
  details: null;
}
type NetListener = (s: NetSnapshot) => void;
const mockNet = { connected: true, listeners: new Set<NetListener>() };

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: (): Promise<NetSnapshot> =>
      Promise.resolve({
        isConnected: mockNet.connected,
        type: 'wifi',
        details: null,
      }),
    addEventListener: (cb: NetListener): (() => void) => {
      mockNet.listeners.add(cb);
      return () => {
        mockNet.listeners.delete(cb);
      };
    },
  },
}));

import { syncEngine } from '../SyncEngine';
import { getDatabase } from '../../../infra/db/database';
import { Message, Conversation } from '../../../infra/db/models';
import {
  purgeAllLocalChat,
  upsertConversation,
} from '../../../infra/db/queries';
import { applyServerMessages } from '../../../infra/db/messages';
import { clearAllReceipts } from '../../../infra/db/receiptStore';
import { kv, KVKeys } from '../../../infra/kv';
import { AppError } from '../../../infra/network/errors';

// ── fixtures ─────────────────────────────────────────────────────────────────

const ME = 'acct_me';
const PEER = 'acct_peer';
const T0 = 1_700_000_000_000;

/** The server's view of a conversation's history, served by the fake `fetchMessagesAfter`. */
const serverHistory = new Map<string, ServerMessage[]>();

function serverMsg(
  conversationId: string,
  seq: number,
  overrides: Partial<ServerMessage> = {},
): ServerMessage {
  return {
    messageId: `srv_${conversationId}_${String(seq)}`,
    conversationId,
    seq,
    senderId: PEER,
    type: 'text',
    content: `body ${String(seq)}`,
    serverTs: T0 + seq * 1000,
    ...overrides,
  };
}

/** Exactly what the REST endpoint does: rows with `seq > afterSeq`, ordered, clamped to 100. */
function serveAfter(
  conversationId: string,
  afterSeq: number,
  limit?: number,
): ServerMessage[] {
  const all = serverHistory.get(conversationId) ?? [];
  return all
    .filter(m => m.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)
    .slice(0, Math.max(1, Math.min(100, limit ?? 100)));
}

function setNetwork(connected: boolean): void {
  mockNet.connected = connected;
  for (const listener of [...mockNet.listeners]) {
    listener({ isConnected: connected, type: 'wifi', details: null });
  }
}

function latestSocket(): MockSocket {
  const s = mockSockets[mockSockets.length - 1];
  if (!s) throw new Error('no socket was opened');
  return s;
}

/** Poll until `predicate` holds. The engine does most of its work fire-and-forget. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Let the engine's already-queued async work run to completion before asserting a NEGATIVE. */
function settle(ms = 60): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function messagesOf(conversationId: string): Promise<Message[]> {
  return getDatabase()
    .get<Message>('messages')
    .query(Q.where('conversation_id', conversationId))
    .fetch();
}

async function rowsBySeq(conversationId: string): Promise<Message[]> {
  const rows = await messagesOf(conversationId);
  return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function conversationRow(id: string): Promise<Conversation> {
  return getDatabase().get<Conversation>('conversations').find(id);
}

/** Bring the engine up with a live, connected socket (the server's `connected` frame). */
async function bootConnected(): Promise<MockSocket> {
  syncEngine.start();
  await until(() => mockSockets.length > 0, 'the socket to open');
  const socket = latestSocket();
  socket.cb.onConnected?.(undefined);
  return socket;
}

beforeEach(async () => {
  mockSockets.length = 0;
  serverHistory.clear();
  mockFetchAfter.mockReset();
  mockFetchAfter.mockImplementation(
    (conversationId: string, afterSeq: number, limit?: number) =>
      Promise.resolve(serveAfter(conversationId, afterSeq, limit)),
  );
  mockSendChat.mockReset();
  mockNet.connected = true;
  mockNet.listeners.clear();

  kv.clearAll();
  kv.set(KVKeys.accessToken, 'test.access.token');
  kv.set(KVKeys.accountId, ME);
  clearAllReceipts();
  await purgeAllLocalChat();
});

afterEach(() => {
  syncEngine.stop();
  syncEngine.setActiveConversation(null);
});

// ── 1. reconnect: a socket drop must not abandon the rest of the catch-up ─────

describe('catch-up after a reconnect', () => {
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];

  beforeEach(async () => {
    for (const id of ids) {
      await upsertConversation(id, { type: 'dm', name: id });
      serverHistory.set(id, [
        serverMsg(id, 1),
        serverMsg(id, 2),
        serverMsg(id, 3),
      ]);
    }
  });

  it('backfills every remaining conversation after the socket drops mid-catch-up', async () => {
    let dropped = false;
    const touched = new Set<string>();
    mockFetchAfter.mockImplementation(
      (conversationId: string, afterSeq: number, limit?: number) => {
        touched.add(conversationId);
        // The instant a SECOND conversation is reached, the link dies. Everything still
        // outstanding is now running with no socket at all — and must still complete,
        // because the backfill is plain REST and does not need one.
        if (!dropped && touched.size >= 2) {
          dropped = true;
          latestSocket().drop(1006, 'link lost');
        }
        return Promise.resolve(serveAfter(conversationId, afterSeq, limit));
      },
    );

    await bootConnected();

    await until(async () => {
      for (const id of ids) {
        if ((await messagesOf(id)).length < 3) return false;
      }
      return true;
    }, 'every conversation to be backfilled');

    expect(dropped).toBe(true);
    for (const id of ids) {
      const rows = await rowsBySeq(id);
      expect(rows.map(r => r.seq)).toEqual([1, 2, 3]);
    }
  });

  it('pages until the server runs out instead of stopping at one page', async () => {
    // 250 missed messages: the server clamps a page to 100, so a single request truncates.
    serverHistory.set(
      'c1',
      Array.from({ length: 250 }, (_, i) => serverMsg('c1', i + 1)),
    );
    await bootConnected();

    await until(
      async () => (await messagesOf('c1')).length === 250,
      'the full 250-message gap to be paged in',
    );
    const rows = await rowsBySeq('c1');
    expect(rows.map(r => r.seq)).toEqual(
      Array.from({ length: 250 }, (_, i) => i + 1),
    );
  });

  it('catches up the conversation on screen in the first wave', async () => {
    syncEngine.setActiveConversation('c5');
    await bootConnected();

    await until(
      () => mockFetchAfter.mock.calls.length >= 4,
      'the first wave of backfills',
    );
    const order = mockFetchAfter.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    // RESYNC_CONCURRENCY is 4, so "first" means "inside the first concurrent wave".
    expect(order.indexOf('c5')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('c5')).toBeLessThan(4);
  });
});

// ── 2. the same realtime frame applied twice ─────────────────────────────────

describe('a duplicate realtime frame', () => {
  const conv = 'dup_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('produces one row, one unread and one preview — however many times it lands', async () => {
    const socket = await bootConnected();
    const frame = {
      messageId: 'srv_dup_7',
      conversationId: conv,
      seq: 7,
      senderId: PEER,
      type: 'text',
      content: 'only once',
      serverTs: T0 + 7000,
    };

    socket.cb.onMessage?.(frame);
    await until(
      async () => (await messagesOf(conv)).length === 1,
      'the first copy to land',
    );

    socket.cb.onMessage?.(frame);
    socket.cb.onMessage?.(frame);
    await settle();

    const rows = await messagesOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentPlain).toBe('only once');

    const row = await conversationRow(conv);
    expect(row.unreadCount).toBe(1);
    expect(row.lastMessagePreview).toBe('only once');
    expect(row.lastMessageSeq).toBe(7);
  });

  it('does not duplicate when a whole catch-up is replayed', async () => {
    // A second `connected` frame (flapping link) replays the same window. Idempotency here
    // is what stops a reconnect storm from doubling a conversation.
    serverHistory.set(conv, [serverMsg(conv, 1), serverMsg(conv, 2)]);
    await bootConnected();
    await until(
      async () => (await messagesOf(conv)).length === 2,
      'the first catch-up',
    );

    // Re-serve the same window regardless of the cursor, as a stale/inclusive server would.
    mockFetchAfter.mockImplementation((conversationId: string) =>
      Promise.resolve(
        conversationId === conv ? (serverHistory.get(conv) ?? []) : [],
      ),
    );
    latestSocket().cb.onConnected?.(undefined);
    await settle();

    const rows = await rowsBySeq(conv);
    expect(rows.map(r => r.seq)).toEqual([1, 2]);
    expect((await conversationRow(conv)).unreadCount).toBe(2);
  });
});

// ── 3. own echo: the sender receives its own message back ────────────────────

describe('own-echo reconciliation', () => {
  const conv = 'echo_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('updates the optimistic row instead of drawing a second bubble', async () => {
    const inFlight = deferred<SendAck>();
    mockSendChat.mockImplementation(() => inFlight.promise);
    const socket = await bootConnected();

    await syncEngine.sendText(conv, ME, 'hello there');
    await until(
      async () => (await messagesOf(conv)).length === 1,
      'the optimistic bubble',
    );
    const optimistic = (await messagesOf(conv))[0];
    const clientMsgId = optimistic?.clientMsgId;
    expect(optimistic?.state).toBe('sending');
    expect(clientMsgId).toBeTruthy();

    // The gateway fans our own message back to us before the REST ack returns.
    socket.cb.onMessage?.({
      messageId: 'srv_echo_1',
      conversationId: conv,
      seq: 42,
      senderId: ME,
      client_msg_id: clientMsgId,
      type: 'text',
      content: 'hello there',
      serverTs: T0 + 42_000,
    });

    await until(
      async () => (await messagesOf(conv))[0]?.seq === 42,
      'the echo to reconcile onto the optimistic row',
    );

    const rows = await messagesOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientMsgId).toBe(clientMsgId);
    expect(rows[0]?.state).toBe('sent');
    // Our own message is never unread, and never bumps the badge.
    expect((await conversationRow(conv)).unreadCount).toBe(0);

    inFlight.resolve({
      messageId: 'srv_echo_1',
      seq: 42,
      serverTs: T0 + 42_000,
    });
  });

  it('collapses back to one row when the echo carries no client_msg_id', async () => {
    // The WS MessageSentPayload may omit clientMsgId, so the echo cannot be matched to the
    // optimistic row and lands as a second bubble. The ack is what has to heal it.
    const inFlight = deferred<SendAck>();
    mockSendChat.mockImplementation(() => inFlight.promise);
    const socket = await bootConnected();

    await syncEngine.sendText(conv, ME, 'no id echo');
    await until(
      async () => (await messagesOf(conv)).length === 1,
      'the optimistic bubble',
    );

    socket.cb.onMessage?.({
      messageId: 'srv_echo_2',
      conversationId: conv,
      seq: 77,
      senderId: ME,
      type: 'text',
      content: 'no id echo',
      serverTs: T0 + 77_000,
    });
    await until(
      async () => (await messagesOf(conv)).length === 2,
      'the un-matchable echo to land',
    );

    inFlight.resolve({
      messageId: 'srv_echo_2',
      seq: 77,
      serverTs: T0 + 77_000,
    });

    await until(
      async () => (await messagesOf(conv)).length === 1,
      'the ack to collapse the duplicate',
    );
    const rows = await messagesOf(conv);
    expect(rows[0]?.seq).toBe(77);
    expect(rows[0]?.state).toBe('sent');
    expect((await conversationRow(conv)).unreadCount).toBe(0);
  });
});

// ── 4. late / out-of-order frames never move state backwards ─────────────────

describe('a late frame', () => {
  const conv = 'late_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('cannot pull a read message back to sent', async () => {
    const ack = deferred<SendAck>();
    mockSendChat.mockImplementation(() => ack.promise);
    const socket = await bootConnected();

    await syncEngine.sendText(conv, ME, 'ticks matter');
    await until(
      async () => (await messagesOf(conv)).length === 1,
      'the optimistic bubble',
    );
    const clientMsgId = (await messagesOf(conv))[0]?.clientMsgId;

    socket.cb.onMessage?.({
      messageId: 'srv_late_1',
      conversationId: conv,
      seq: 10,
      senderId: ME,
      client_msg_id: clientMsgId,
      type: 'text',
      content: 'ticks matter',
      serverTs: T0 + 10_000,
    });
    await until(
      async () => (await messagesOf(conv))[0]?.seq === 10,
      'the echo to reconcile',
    );

    socket.cb.onReceipt?.({ conversationId: conv, upToSeq: 10, state: 'read' });
    await until(
      async () => (await messagesOf(conv))[0]?.state === 'read',
      'the read receipt',
    );

    // The REST ack for the very same send finally returns, long after the peer read it.
    ack.resolve({ messageId: 'srv_late_1', seq: 10, serverTs: T0 + 10_000 });
    await settle();
    expect((await messagesOf(conv))[0]?.state).toBe('read');

    // And a replay of the echo frame must not downgrade it either.
    socket.cb.onMessage?.({
      messageId: 'srv_late_1',
      conversationId: conv,
      seq: 10,
      senderId: ME,
      client_msg_id: clientMsgId,
      type: 'text',
      content: 'ticks matter',
      serverTs: T0 + 10_000,
    });
    await settle();
    const rows = await messagesOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('read');
  });

  it('does not rewrite the chat-list preview with older content', async () => {
    const socket = await bootConnected();
    socket.cb.onMessage?.({
      messageId: 'srv_new',
      conversationId: conv,
      seq: 20,
      senderId: PEER,
      type: 'text',
      content: 'newest',
      serverTs: T0 + 20_000,
    });
    await until(
      async () => (await conversationRow(conv)).lastMessageSeq === 20,
      'the newest message to set the preview',
    );

    // A straggler from before it now arrives (best-effort fan-out is not ordered).
    socket.cb.onMessage?.({
      messageId: 'srv_old',
      conversationId: conv,
      seq: 5,
      senderId: PEER,
      type: 'text',
      content: 'older',
      serverTs: T0 + 5000,
    });
    await until(
      async () => (await messagesOf(conv)).length === 2,
      'the straggler to be stored',
    );

    const row = await conversationRow(conv);
    expect(row.lastMessagePreview).toBe('newest');
    expect(row.lastMessageSeq).toBe(20);
    // It is still a message the user has not seen, so the badge counts both.
    expect(row.unreadCount).toBe(2);
    const rows = await rowsBySeq(conv);
    expect(rows.map(r => r.seq)).toEqual([5, 20]);
    // The timeline sort key follows the SERVER clock, so the straggler sorts where it belongs.
    expect(rows.map(r => r.createdAt)).toEqual([T0 + 5000, T0 + 20_000]);
  });
});

// ── 5. offline send → reconnect, with the SAME client_msg_id ─────────────────

describe('a message composed offline', () => {
  const conv = 'offline_conv';

  beforeEach(async () => {
    mockNet.connected = false;
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('transmits on reconnect under the client_msg_id the bubble was written with', async () => {
    mockSendChat.mockImplementation((input: SendMessageInput) =>
      Promise.resolve({
        messageId: `srv_${input.clientMsgId}`,
        seq: 5,
        serverTs: T0 + 5000,
      }),
    );
    syncEngine.start();
    await settle(20);

    await syncEngine.sendText(conv, ME, 'sent from the tunnel');
    await until(
      async () => (await messagesOf(conv)).length === 1,
      'the optimistic bubble',
    );
    const queued = (await messagesOf(conv))[0];
    const clientMsgId = queued?.clientMsgId;
    expect(queued?.state).toBe('sending');
    expect(mockSendChat).not.toHaveBeenCalled();
    expect(mockSockets).toHaveLength(0);

    setNetwork(true);

    await until(
      async () => (await messagesOf(conv))[0]?.state === 'sent',
      'the queued send to drain after reconnect',
    );
    expect(mockSendChat).toHaveBeenCalledTimes(1);
    const input = mockSendChat.mock.calls[0]?.[0] as SendMessageInput;
    expect(input.clientMsgId).toBe(clientMsgId);
    expect(input.content).toBe('sent from the tunnel');
    // Idempotency key intact + exactly one row: the server can safely dedupe a retry.
    const rows = await messagesOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(5);
  });

  it('drains a whole offline backlog in compose order, each with its own stable id', async () => {
    let nextSeq = 100;
    mockSendChat.mockImplementation((input: SendMessageInput) =>
      Promise.resolve({
        messageId: `srv_${input.clientMsgId}`,
        seq: nextSeq++,
        serverTs: T0 + nextSeq * 1000,
      }),
    );
    syncEngine.start();
    await settle(20);

    await syncEngine.sendText(conv, ME, 'one');
    await syncEngine.sendText(conv, ME, 'two');
    await syncEngine.sendText(conv, ME, 'three');
    expect(mockSendChat).not.toHaveBeenCalled();

    setNetwork(true);
    await until(
      () => mockSendChat.mock.calls.length === 3,
      'all three queued sends to drain',
    );

    const bodies = mockSendChat.mock.calls.map(
      (call: unknown[]) => (call[0] as SendMessageInput).content,
    );
    expect(bodies).toEqual(['one', 'two', 'three']);
    const ids = mockSendChat.mock.calls.map(
      (call: unknown[]) => (call[0] as SendMessageInput).clientMsgId,
    );
    expect(new Set(ids).size).toBe(3);

    await until(
      async () => (await messagesOf(conv)).every(m => m.state === 'sent'),
      'every bubble to reach sent',
    );
    const rows = await rowsBySeq(conv);
    expect(rows.map(r => r.contentPlain)).toEqual(['one', 'two', 'three']);
  });
});

// ── 6. failed send + manual retry ────────────────────────────────────────────

describe('a send the server refuses', () => {
  const conv = 'fail_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('surfaces `failed`, and a manual retry re-queues the same id and succeeds', async () => {
    mockSendChat.mockImplementation(() =>
      Promise.reject(
        new AppError('client', 'rejected', {
          statusCode: 400,
          retryable: false,
        }),
      ),
    );
    await bootConnected();

    await syncEngine.sendText(conv, ME, 'refused once');
    await until(
      async () => (await messagesOf(conv))[0]?.state === 'failed',
      'the bubble to surface as failed',
    );
    const clientMsgId = (await messagesOf(conv))[0]?.clientMsgId ?? '';
    expect(clientMsgId).toBeTruthy();
    const attempted = mockSendChat.mock.calls.length;

    mockSendChat.mockImplementation((input: SendMessageInput) =>
      Promise.resolve({
        messageId: `srv_${input.clientMsgId}`,
        seq: 31,
        serverTs: T0 + 31_000,
      }),
    );
    await syncEngine.retrySend(clientMsgId);

    await until(
      async () => (await messagesOf(conv))[0]?.state === 'sent',
      'the retry to succeed',
    );
    expect(mockSendChat.mock.calls.length).toBe(attempted + 1);
    const retried = mockSendChat.mock.calls[attempted]?.[0] as SendMessageInput;
    expect(retried.clientMsgId).toBe(clientMsgId);
    const rows = await messagesOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(31);
  });

  it('keeps the clock icon — never a red bubble — while the server is merely unreachable', async () => {
    mockSendChat.mockImplementation(() =>
      Promise.reject(new AppError('network', 'no route')),
    );
    await bootConnected();

    await syncEngine.sendText(conv, ME, 'in a tunnel');
    await until(
      () => mockSendChat.mock.calls.length >= 1,
      'the first transmit attempt',
    );
    await settle();

    const rows = await messagesOf(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('sending');
  });
});

// ── 7. unread counts ─────────────────────────────────────────────────────────

describe('the unread badge', () => {
  const open = 'open_conv';
  const other = 'other_conv';

  beforeEach(async () => {
    await upsertConversation(open, { type: 'dm', name: 'Open' });
    await upsertConversation(other, { type: 'dm', name: 'Other' });
  });

  it('does not climb on the conversation the user is looking at', async () => {
    syncEngine.setActiveConversation(open);
    const socket = await bootConnected();

    socket.cb.onMessage?.({
      messageId: 'srv_open_1',
      conversationId: open,
      seq: 1,
      senderId: PEER,
      type: 'text',
      content: 'you are reading this',
      serverTs: T0 + 1000,
    });
    await until(
      async () => (await messagesOf(open)).length === 1,
      'the message to land in the open chat',
    );
    await settle();

    expect((await conversationRow(open)).unreadCount).toBe(0);
    // ...and the peer is told it was read, which is what turns their ticks blue live.
    await until(
      () => socket.sent.some(f => f.type === 'read'),
      'the read receipt to be emitted',
    );
    expect(socket.sent.find(f => f.type === 'read')?.data).toEqual({
      conversationId: open,
      seq: 1,
    });
  });

  it('climbs on every other conversation', async () => {
    syncEngine.setActiveConversation(open);
    const socket = await bootConnected();

    for (const seq of [1, 2, 3]) {
      socket.cb.onMessage?.({
        messageId: `srv_other_${String(seq)}`,
        conversationId: other,
        seq,
        senderId: PEER,
        type: 'text',
        content: `elsewhere ${String(seq)}`,
        serverTs: T0 + seq * 1000,
      });
    }
    await until(
      async () => (await messagesOf(other)).length === 3,
      'the three messages to land elsewhere',
    );
    await settle();

    expect((await conversationRow(other)).unreadCount).toBe(3);
    expect((await conversationRow(open)).unreadCount).toBe(0);
  });

  it('clears when the user opens the chat, and reports the read watermark', async () => {
    const socket = await bootConnected();
    socket.cb.onMessage?.({
      messageId: 'srv_other_9',
      conversationId: other,
      seq: 9,
      senderId: PEER,
      type: 'text',
      content: 'unseen',
      serverTs: T0 + 9000,
    });
    await until(
      async () => (await conversationRow(other)).unreadCount === 1,
      'the badge to appear',
    );

    await syncEngine.markConversationRead(other);
    expect((await conversationRow(other)).unreadCount).toBe(0);
    await until(
      () => socket.sent.some(f => f.type === 'read'),
      'the read frame',
    );
    expect(socket.sent.find(f => f.type === 'read')?.data).toEqual({
      conversationId: other,
      seq: 9,
    });
  });
});

// ── 8. read receipts: cumulative, monotonic, and re-applied after a backfill ──

describe('read receipts', () => {
  const conv = 'rcpt_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('are cumulative: one watermark lifts every message at or below it', async () => {
    serverHistory.set(
      conv,
      [1, 2, 3, 4].map(seq => serverMsg(conv, seq, { senderId: ME })),
    );
    const socket = await bootConnected();
    await until(
      async () => (await messagesOf(conv)).length === 4,
      'our four messages to exist locally',
    );

    socket.cb.onReceipt?.({ conversationId: conv, upToSeq: 3, state: 'read' });
    await until(
      async () => (await rowsBySeq(conv))[2]?.state === 'read',
      'the cumulative read to apply',
    );
    const rows = await rowsBySeq(conv);
    expect(rows.map(r => r.state)).toEqual(['read', 'read', 'read', 'sent']);
  });

  it('flushOutboxNow waits for a send already in flight', async () => {
    // The reply-from-a-notification bug, reduced to one assertion.
    //
    // A headless task is killed the INSTANT its promise resolves. `sendText` kicks a drain of its
    // own and returns, so `flushOutboxNow` saw `draining` and returned immediately: the task
    // completed, the foreground service stopped, and the HTTP send died in flight. The reply then
    // sat in the outbox until the app was next opened — from the user's side, indistinguishable
    // from a reply that never sent. Measured on a real device: the service stopped 164 ms after
    // JS began draining.
    let release: (() => void) | undefined;
    mockSendChat.mockImplementationOnce(
      (input: SendMessageInput) =>
        new Promise(resolve => {
          release = () =>
            resolve({
              messageId: 'srv_slow',
              seq: 1,
              clientMsgId: input.clientMsgId,
            });
        }),
    );

    await bootConnected();
    // Starts the drain that used to make the flush a no-op.
    await syncEngine.sendText(conv, ME, 'slow one');

    let flushed = false;
    const flush = syncEngine.flushOutboxNow().then(() => {
      flushed = true;
    });
    await new Promise(r => setTimeout(r, 50));
    expect(flushed).toBe(false); // the send is still in flight

    release?.();
    await flush;
    expect(flushed).toBe(true);
  });

  it('repairs a tick from the durable store when the socket frame never arrived', async () => {
    // The gap this closes. Receipts travel as live socket frames, and a frame missed is a frame
    // lost: if the peer reads while this device is reconnecting, nothing ever re-derives it and
    // the bubble keeps ONE tick however long ago it was really read. The server has held the
    // answer all along (the receipts store, §B4.4) and nothing ever asked it.
    serverHistory.set(
      conv,
      [1, 2, 3].map(seq => serverMsg(conv, seq, { senderId: ME })),
    );
    // No onReceipt is ever fired for this conversation — that is the point.
    mockServerReceipts.set(conv, [
      { userId: 'peer', state: 'read', upToSeq: 2 },
    ]);

    await bootConnected();

    await until(
      async () => (await rowsBySeq(conv))[1]?.state === 'read',
      'the durable read watermark to repair the ticks',
    );
    const rows = await rowsBySeq(conv);
    expect(rows.map(r => r.state)).toEqual(['read', 'read', 'sent']);
  });

  it('never regress when a stale watermark arrives after a newer one', async () => {
    serverHistory.set(
      conv,
      [1, 2].map(seq => serverMsg(conv, seq, { senderId: ME })),
    );
    const socket = await bootConnected();
    await until(
      async () => (await messagesOf(conv)).length === 2,
      'our messages to exist locally',
    );

    socket.cb.onReceipt?.({ conversationId: conv, upToSeq: 2, state: 'read' });
    await until(
      async () => (await rowsBySeq(conv)).every(r => r.state === 'read'),
      'both to be read',
    );

    socket.cb.onReceipt?.({
      conversationId: conv,
      upToSeq: 1,
      state: 'delivered',
    });
    socket.cb.onReceipt?.({
      conversationId: conv,
      upToSeq: 2,
      state: 'delivered',
    });
    await settle();

    expect((await rowsBySeq(conv)).map(r => r.state)).toEqual(['read', 'read']);
  });

  it('is re-applied to messages that only arrive later', async () => {
    // The classic stuck-grey-tick: the peer's `read` for seq 3 lands while we hold nothing,
    // then the backfill delivers 1-3. Nothing in the frame survives to lift those rows
    // unless the watermark was remembered.
    const socket = await bootConnected();
    socket.cb.onReceipt?.({ conversationId: conv, upToSeq: 3, state: 'read' });
    await settle(20);
    expect(await messagesOf(conv)).toHaveLength(0);

    serverHistory.set(
      conv,
      [1, 2, 3].map(seq => serverMsg(conv, seq, { senderId: ME })),
    );
    socket.cb.onConnected?.(undefined);

    await until(
      async () => (await messagesOf(conv)).length === 3,
      'the backfill to deliver our messages',
    );
    await until(
      async () => (await rowsBySeq(conv)).every(r => r.state === 'read'),
      'the remembered watermark to be re-applied',
    );
  });
});

// ── 9. pagination: load older never duplicates, loses or reorders ────────────

describe('loading older history', () => {
  const conv = 'page_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
    serverHistory.set(
      conv,
      Array.from({ length: 120 }, (_, i) => serverMsg(conv, i + 1)),
    );
  });

  /**
   * Seed the newest slice locally, exactly as a first open would leave it.
   *
   * Applied directly rather than through `loadOlderMessages`: that call means "fetch the page
   * BEFORE what we hold", so with an empty database it has no anchor and correctly does nothing.
   * Using it to seed would be testing the API against a contract it does not have.
   */
  async function seedNewest(count: number): Promise<void> {
    const all = serverHistory.get(conv) ?? [];
    await applyServerMessages(all.slice(all.length - count));
  }

  it('walks back page by page with no duplicates, no holes and no reordering', async () => {
    await seedNewest(20); // holds 101..120
    expect(await messagesOf(conv)).toHaveLength(20);

    let guard = 0;
    for (;;) {
      const more = await syncEngine.loadOlderMessages(conv, 50);
      if (!more) break;
      if (++guard > 10) throw new Error('pagination did not terminate');
    }

    const rows = await rowsBySeq(conv);
    expect(rows).toHaveLength(120);
    expect(rows.map(r => r.seq)).toEqual(
      Array.from({ length: 120 }, (_, i) => i + 1),
    );
    // Sorting by the timeline key must give the same order as sorting by seq.
    const byCreatedAt = [...rows].sort((a, b) => a.createdAt - b.createdAt);
    expect(byCreatedAt.map(r => r.seq)).toEqual(rows.map(r => r.seq));
  });

  it('reports nothing more to load once the first message is held', async () => {
    await seedNewest(120);
    expect(await syncEngine.loadOlderMessages(conv, 50)).toBe(false);
    expect(await messagesOf(conv)).toHaveLength(120);
  });

  it('is safe to run twice at once — a double-tap cannot duplicate a page', async () => {
    await seedNewest(20);
    const [a, b] = await Promise.all([
      syncEngine.loadOlderMessages(conv, 50),
      syncEngine.loadOlderMessages(conv, 50),
    ]);
    expect(a || b).toBe(true);

    const rows = await rowsBySeq(conv);
    const seqs = rows.map(r => r.seq ?? 0);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });
});

// ── 10. concurrent applyServerMessages on the same conversation (VC-020) ─────
//
// `applyServerMessages` reads `existingByClient`/`existingBySeq`/`existingConvs` OUTSIDE
// `db.write` (a deliberate perf fix — seeing the comment above that Promise.all in messages.ts).
// WatermelonDB serializes `db.write` calls against each other, but NOT the reads before them, so
// two legitimately different callers for the SAME conversation — `resyncAll`'s page walk and an
// inbound gap-probe's `backfillConversation`, say — can each read "nothing exists yet" and both
// decide to INSERT the same logical message.

describe('overlapping applyServerMessages for one conversation', () => {
  const conv = 'race_batch_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('does not duplicate a batch when two callers race to apply the same window', async () => {
    const batch = [serverMsg(conv, 1), serverMsg(conv, 2), serverMsg(conv, 3)];

    await Promise.all([applyServerMessages(batch), applyServerMessages(batch)]);

    const rows = await rowsBySeq(conv);
    expect(rows.map(r => r.seq)).toEqual([1, 2, 3]);
  });

  it('does not drop the second caller’s extra messages when both also race to create the same new-conversation stub', async () => {
    const stub = 'race_stub_conv';
    // Neither caller holds this conversation locally yet, so both also try to create the SAME
    // stub row (a brand-new DM). `pageA` is resyncAll's page; `pageB` is a gap-probe that fetched
    // a touch later and saw two more messages that had landed in the meantime.
    const pageA = [serverMsg(stub, 1), serverMsg(stub, 2), serverMsg(stub, 3)];
    const pageB = [
      serverMsg(stub, 1),
      serverMsg(stub, 2),
      serverMsg(stub, 3),
      serverMsg(stub, 4),
      serverMsg(stub, 5),
    ];

    const results = await Promise.allSettled([
      applyServerMessages(pageA),
      applyServerMessages(pageB),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') throw r.reason;
    }

    const rows = await rowsBySeq(stub);
    expect(rows.map(r => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await conversationRow(stub)).unreadCount).toBe(5);
  });
});

// ── 11. concurrent receipts for the same message must never regress (VC-021) ─
//
// Monotonicity ("only move a message to a HIGHER state") is enforced only in the query
// predicate of `applyReceipt`, which is evaluated in a `.fetch()` OUTSIDE `db.write`. Two
// independent, un-awaited receipt frames — a live `read` and a late/reconciled `delivered` for
// the same watermark — can each read the row's stale pre-write state and race to write.

describe('concurrent receipts for the same message', () => {
  const conv = 'concurrent_receipt_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('leaves the row at read, never regressed to delivered, when both arrive together', async () => {
    serverHistory.set(
      conv,
      [1, 2, 3, 4].map(seq => serverMsg(conv, seq, { senderId: ME })),
    );
    const socket = await bootConnected();
    await until(
      async () => (await messagesOf(conv)).length === 4,
      'our four messages to exist locally',
    );

    // Fired back to back, un-awaited: `onInboundReceipt` awaits `peerIdFor` before it ever
    // reaches `applyReceipt`, so both handlers' read phases are in flight at once.
    socket.cb.onReceipt?.({ conversationId: conv, upToSeq: 4, state: 'read' });
    socket.cb.onReceipt?.({
      conversationId: conv,
      upToSeq: 4,
      state: 'delivered',
    });

    await until(
      async () => (await rowsBySeq(conv)).every(r => r.state !== 'sent'),
      'both receipts to be applied',
    );
    await settle();

    expect((await rowsBySeq(conv)).map(r => r.state)).toEqual([
      'read',
      'read',
      'read',
      'read',
    ]);
  });
});

// ── 12. a reconnect backfill into the OPEN conversation (VC-026) ─────────────
//
// The live-message path treats a message landing in the conversation on screen as read at once
// (§ "unread badge" above). A reconnect's catch-up backfill for that same conversation must do
// the same — otherwise the badge climbs, and the peer never learns we've read it, until the user
// leaves and re-enters the chat.

describe('backfill into the conversation on screen', () => {
  const conv = 'active_backfill_conv';

  beforeEach(async () => {
    await upsertConversation(conv, { type: 'dm', name: 'Peer' });
  });

  it('does not stall unread/read state when the reconnect backfill lands in the open chat', async () => {
    syncEngine.setActiveConversation(conv);
    serverHistory.set(
      conv,
      [1, 2, 3].map(seq => serverMsg(conv, seq)),
    );

    const socket = await bootConnected();

    await until(
      async () => (await messagesOf(conv)).length === 3,
      'the backfill to land',
    );
    await settle();

    expect((await conversationRow(conv)).unreadCount).toBe(0);
    await until(
      () => socket.sent.some(f => f.type === 'read'),
      'the read receipt for the backfilled messages',
    );
    expect(socket.sent.find(f => f.type === 'read')?.data).toEqual({
      conversationId: conv,
      seq: 3,
    });
  });
});
