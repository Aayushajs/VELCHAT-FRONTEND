/**
 * RealtimeSocket (§M8/§L4) — owns exactly ONE WebSocket to the realtime-gateway `/ws`.
 *
 * Contract (docs/backend-integration-reference.md §4):
 *   - URL: `ws://<host>/ws?token=<access>`. RN's WebSocket can't set headers reliably, so
 *     the access token rides the query string. Missing account_id/device_id → server 4001.
 *   - Frame envelope both directions: `{ kind, type, data }` (JSON). `event_id`/`seq`/
 *     `conversation_id` live INSIDE `data`.
 *   - Client→server control: `ping`(→pong), `sync {cursor}`, `delivered/read {…}`,
 *     `typing {…}`. Server→client: `connected, pong, sync, message, receipt, caption,
 *     reconnect`.
 *
 * This class is a DUMB transport: it parses/dispatches frames, heartbeats, and closes on a
 * dead link — it does NOT decide reconnect policy (the SyncEngine owns that). Every timer +
 * the socket itself is owned and disposed on close (§M7). It never auto-reconnects; it
 * reports every close (with code) up so the engine can apply jittered backoff / honour 4001.
 */
import { log } from '../../core';

/** Ping cadence (~25s): server pings at 25s / registry TTL 30s — keep the entry warm. */
const PING_INTERVAL_MS = 25_000;
/** Watchdog: no inbound frame within this window ⇒ the link is dead → close + report. */
const DEAD_AFTER_MS = 60_000;
/**
 * Handshake deadline. A WebSocket that never leaves CONNECTING never fires `onopen` OR
 * `onclose` — a captive portal or a stalled TCP handshake can hold it there for as long as
 * the OS allows (minutes, or forever on some carriers). The engine is single-flight and only
 * re-arms on a REPORTED close, so an unbounded handshake is not a slow connect: it is a
 * permanently dead realtime link that still renders as "connecting". Bound it here.
 */
const CONNECT_TIMEOUT_MS = 15_000;
/** App-defined close code for a watchdog-detected dead link (distinct from server codes). */
export const WS_CODE_DEAD = 4000;
/** Server close code when the connection is missing account_id/device_id (do NOT retry). */
export const WS_CODE_UNAUTHORIZED = 4001;

/** readyState constants (WebSocket.CONNECTING / OPEN) — hard-coded to sidestep an ambient
 *  global `WebSocket` TYPE collision (React Native vs undici-types) under this tsconfig. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/** The subset of the RN WebSocket instance this transport uses (structural — deliberately
 *  NOT the ambient global `WebSocket` type, which collides with undici-types here). */
interface AppWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

/** Runtime WebSocket constructor (global), typed to produce our structural instance. */
const WebSocketCtor = WebSocket as unknown as {
  new (url: string): AppWebSocket;
};

/** Typed callbacks — all optional; `data` is the parsed frame `data` (engine normalises). */
export interface RealtimeSocketCallbacks {
  onOpen?: () => void;
  onConnected?: (data: unknown) => void;
  onMessage?: (data: unknown) => void;
  onReceipt?: (data: unknown) => void;
  /** Inbound ephemeral typing (§C4): `data` = `{conversationId,userId}`; `state` from the frame type. */
  onTyping?: (data: unknown, state: 'start' | 'stop') => void;
  /** Inbound ephemeral presence (§A15): `data` = a `PresenceChangedPayload`-shaped object. */
  onPresence?: (data: unknown) => void;
  onReconnectRequested?: () => void;
  /** Fires exactly once per socket for a NON-intentional close (network/server/watchdog). */
  onClose?: (code: number, reason: string) => void;
}

interface WsFrame {
  kind?: string;
  type?: string;
  data?: unknown;
}

/** Client control frames that must not be coalesced away → durable; presence-ish → ephemeral. */
function frameKind(type: string): 'durable' | 'ephemeral' {
  return type === 'typing' || type === 'ping' ? 'ephemeral' : 'durable';
}

export class RealtimeSocket {
  private ws: AppWebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRxAt = 0;
  /** Guards against a double onClose report (intentional close detaches handlers). */
  private reported = false;

  constructor(private readonly cb: RealtimeSocketCallbacks) {}

  /** True while a socket is OPEN or CONNECTING — the engine uses this for single-flight. */
  get isActive(): boolean {
    return (
      this.ws !== null &&
      (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)
    );
  }

  /** Open the socket. `token` is the access JWT — appended as `?token=` (RN header limits). */
  connect(token: string, baseWsUrl: string): void {
    if (this.ws) return; // one socket per instance
    const sep = baseWsUrl.includes('?') ? '&' : '?';
    const url = `${baseWsUrl}${sep}token=${encodeURIComponent(token)}`;
    this.reported = false;
    this.lastRxAt = Date.now();
    let ws: AppWebSocket;
    try {
      ws = new WebSocketCtor(url);
    } catch (e) {
      // Constructing can throw synchronously on a malformed URL — report as a close.
      log.warn('ws construct failed', { reason: String(e) });
      this.cb.onClose?.(WS_CODE_DEAD, 'construct-failed');
      return;
    }
    this.ws = ws;
    // Arm the handshake deadline BEFORE any callback can fire: a socket stuck in CONNECTING
    // is reported as a close so the engine's backoff (not this transport) drives the retry.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      log.warn('ws connect timeout — handshake never completed');
      this.teardown();
      this.report(WS_CODE_DEAD, 'connect-timeout');
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      this.clearConnectTimer();
      this.lastRxAt = Date.now();
      this.startTimers();
      this.cb.onOpen?.();
    };
    ws.onmessage = ev => this.handleRaw(ev.data);
    ws.onerror = () => {
      // `onerror` is always followed by `onclose`; log only (avoid a double report).
      log.warn('ws error');
    };
    ws.onclose = ev => {
      const code = typeof ev?.code === 'number' ? ev.code : WS_CODE_DEAD;
      const reason = typeof ev?.reason === 'string' ? ev.reason : '';
      this.teardown();
      this.report(code, reason);
    };
  }

  /**
   * Send a `{kind,type,data}` frame. Silently drops when the socket isn't OPEN — durable
   * loss is covered by the outbox + cursor backstop, so a dropped frame is never fatal.
   */
  send(type: string, data: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(JSON.stringify({ kind: frameKind(type), type, data }));
      return true;
    } catch (e) {
      log.warn('ws send failed', { type, reason: String(e) });
      return false;
    }
  }

  /**
   * Send a client EPHEMERAL control frame. The gateway's inbound router (`ws-fabric` `onInbound`)
   * reads control fields at the TOP LEVEL of the frame (`msg.conversationId`, `msg.state`) — it does
   * NOT unwrap a `data` envelope for INBOUND frames — so an ephemeral client frame is FLAT:
   * `{ kind:'ephemeral', type, ...fields }`. Returns false (dropped) when the socket isn't OPEN;
   * ephemeral loss is by design (§C4 — typing is never re-synced).
   */
  sendEphemeral(type: string, fields: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(JSON.stringify({ kind: 'ephemeral', type, ...fields }));
      return true;
    } catch (e) {
      log.warn('ws sendEphemeral failed', { type, reason: String(e) });
      return false;
    }
  }

  /** Intentional teardown by the owner: no onClose callback (the owner initiated it). */
  close(): void {
    this.reported = true; // suppress the report for an owner-initiated close
    this.teardown();
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private handleRaw(raw: unknown): void {
    this.lastRxAt = Date.now();
    let frame: WsFrame;
    try {
      frame = JSON.parse(
        typeof raw === 'string' ? raw : String(raw),
      ) as WsFrame;
    } catch {
      log.warn('ws non-JSON frame dropped');
      return;
    }
    const type = typeof frame.type === 'string' ? frame.type : '';
    const data = frame.data;
    switch (type) {
      case 'connected':
        this.cb.onConnected?.(data);
        break;
      case 'pong':
        break; // heartbeat ack — lastRxAt already refreshed above
      case 'sync':
        break; // cursor echo — the REST afterSeq backfill is the real catch-up
      case 'message':
        this.cb.onMessage?.(data);
        break;
      case 'receipt':
      case 'caption':
        this.cb.onReceipt?.(data);
        break;
      case 'typing.started':
        this.cb.onTyping?.(data, 'start');
        break;
      case 'typing.stopped':
        this.cb.onTyping?.(data, 'stop');
        break;
      // The realtime-gw may fan presence as either `presence` or `presence.changed` (not yet wired
      // server-side); accept both so live presence works the moment the backend enables it.
      case 'presence':
      case 'presence.changed':
        this.cb.onPresence?.(data);
        break;
      case 'reconnect':
        this.cb.onReconnectRequested?.();
        break;
      case 'skdm':
        break; // per-device key material — ignored until E2EE lands
      default:
        break;
    }
  }

  private startTimers(): void {
    this.stopTimers();
    this.pingTimer = setInterval(() => this.send('ping', {}), PING_INTERVAL_MS);
    // Watchdog runs at the ping cadence; if nothing has arrived in DEAD_AFTER_MS, the
    // link is dead → close so the engine reconnects (server ping/registry TTL is 25/30s).
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastRxAt > DEAD_AFTER_MS) {
        log.warn('ws watchdog: link dead, closing');
        this.teardown();
        this.report(WS_CODE_DEAD, 'watchdog');
      }
    }, PING_INTERVAL_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private stopTimers(): void {
    this.clearConnectTimer();
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Detach handlers, stop timers, close the underlying socket. Idempotent. */
  private teardown(): void {
    this.stopTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already closing/closed — ignore
      }
    }
  }

  private report(code: number, reason: string): void {
    if (this.reported) return;
    this.reported = true;
    this.cb.onClose?.(code, reason);
  }
}
