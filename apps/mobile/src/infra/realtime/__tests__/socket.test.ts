/**
 * RealtimeSocket — bad-network survival (§M8/§L4, §R2 failure scenarios).
 *
 * The reference network is not "wifi at a desk", it is a 3 GB Android on a train: a TCP
 * connection that opens and then stalls mid-handshake, a captive portal that swallows the
 * upgrade, a tower handoff that black-holes the socket without ever delivering `onclose`.
 *
 * The SyncEngine is single-flight (`if (this.socket) return`) and only re-arms when the
 * transport REPORTS a close. So a socket that hangs in CONNECTING forever is not a slow
 * connect — it is a permanently dead app that still renders as "connecting". The transport
 * must therefore bound its own handshake and report a close like any other failure.
 */
type SocketModule = typeof import('../socket');

/** `socket.ts` captures the global `WebSocket` when the module loads, so the fake has to be
 *  installed BEFORE the import — hence the per-test `resetModules()` + `require()`. */
let RealtimeSocket: SocketModule['RealtimeSocket'];
let WS_CODE_DEAD: SocketModule['WS_CODE_DEAD'];

/** Minimal fake of the RN WebSocket: never resolves unless the test drives it. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static instances = 0;
  readyState = 0; // CONNECTING
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.last = this;
    FakeWebSocket.instances += 1;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }
  /** Drive the handshake to OPEN, as a real server would. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe('RealtimeSocket — handshake that never completes', () => {
  const originalWs = (global as { WebSocket?: unknown }).WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.last = null;
    FakeWebSocket.instances = 0;
    (global as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    jest.resetModules();
    const mod = require('../socket') as SocketModule;
    RealtimeSocket = mod.RealtimeSocket;
    WS_CODE_DEAD = mod.WS_CODE_DEAD;
  });

  afterEach(() => {
    jest.useRealTimers();
    (global as { WebSocket?: unknown }).WebSocket = originalWs;
  });

  it('reports a close when the socket never opens, so the engine can back off and retry', () => {
    const onClose = jest.fn();
    const socket = new RealtimeSocket({ onClose });

    socket.connect('tok', 'wss://example.test/ws');
    expect(FakeWebSocket.last).not.toBeNull();

    // Still mid-handshake: nothing reported yet, and the engine correctly sees it as in-flight.
    jest.advanceTimersByTime(5_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.isActive).toBe(true);

    // The handshake never completes. Without a bound, this hangs forever.
    jest.advanceTimersByTime(60_000);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]?.[0]).toBe(WS_CODE_DEAD);
    // The engine must see a free slot, or its single-flight guard blocks every retry.
    expect(socket.isActive).toBe(false);
    expect(FakeWebSocket.last?.closed).toBe(true);
  });

  it('does not report a close when the handshake completes in time', () => {
    const onClose = jest.fn();
    const onOpen = jest.fn();
    const socket = new RealtimeSocket({ onClose, onOpen });

    socket.connect('tok', 'wss://example.test/ws');
    FakeWebSocket.last?.open();
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Well past any connect deadline — a live socket must never be torn down by it.
    jest.advanceTimersByTime(45_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.isActive).toBe(true);

    socket.close();
  });

  it('reports a dead link once when an opened socket goes silent (watchdog)', () => {
    const onClose = jest.fn();
    const socket = new RealtimeSocket({ onClose });

    socket.connect('tok', 'wss://example.test/ws');
    FakeWebSocket.last?.open();

    // No inbound frame at all — the tower black-holed us without an onclose.
    jest.advanceTimersByTime(90_000);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]?.[0]).toBe(WS_CODE_DEAD);
    expect(socket.isActive).toBe(false);
  });
});
