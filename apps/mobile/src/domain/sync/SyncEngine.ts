/**
 * SyncEngine (§L6/§M8) — the offline-first send/receive orchestrator. One singleton owns:
 *   - ONE RealtimeSocket (opened only when online + a session exists),
 *   - the reconnect policy (full-jitter backoff; honour close 4001; single-flight connect),
 *   - the catch-up (per-conversation `sync {cursor}` + REST `afterSeq` backfill — the
 *     no-loss backstop behind best-effort WS push),
 *   - the outbox drain worker (claim due → send → ack, or back off / surface a failure).
 *
 * The local DB is the UI's source of truth (§M0): the engine only ever MUTATES the DB; the
 * UI observes it and never waits on the network. Every timer/socket/subscription is owned
 * and disposed in `stop()` (§M7). Pure decision logic (reconcile branch, backoff schedule,
 * retry threshold) lives in `infra/db/syncLogic.ts` — this file is the wiring.
 */
import {
  appEnv,
  log,
  useRealtimeStore,
  normalizePresenceStatus,
  TYPING_TTL_MS,
} from '../../core';
import type { ConnectionState } from '../../core';
import {
  RealtimeSocket,
  WS_CODE_UNAUTHORIZED,
  hasSession,
  getAccessToken,
  refreshAccessToken,
  getAccountId,
  getConversationMembers,
  getPresence,
  subscribePresence,
  normalizePresenceEvent,
  subscribeNetwork,
  getNetworkStatus,
  subscribeAppState,
  isAppError,
  sendChatMessage,
  fetchMessagesAfter,
  normalizeServerMessage,
  applyServerMessage,
  applyServerMessages,
  markMessageSent,
  markMessageFailed,
  markMessageSending,
  maxSeqForConversation,
  minSeqForConversation,
  applyReceipt,
  enqueueOptimisticSend,
  claimNextDue,
  markAckd,
  markFailed,
  recoverStuckSends,
  requeueFailed,
  outboxStats,
  classifySendFailure,
  shouldProbeGap,
  backoffMs,
  listConversationIds,
  clearUnread,
  upsertConversation,
  pendingReceiptFrames,
  getDesired,
  getSent,
  noteDesired,
  noteSent,
  getPeerWatermark,
  notePeerWatermark,
  markDirty,
  takeDirty,
} from '../../infra';

/** Lower/upper bounds for the outbox self-adjusting timer (never poll a hot loop). */
const OUTBOX_MIN_DELAY_MS = 500;
const OUTBOX_MAX_DELAY_MS = 30_000;
/**
 * How many times a 4001 may be answered with a token refresh before the engine concludes the
 * session is genuinely dead. Bounded so a revoked session degrades to "no realtime" instead of
 * an endless refresh↔connect loop hammering the gateway (the exact shape that earns a 429).
 */
const MAX_AUTH_REFRESH_ATTEMPTS = 2;
/**
 * Receipts are coalesced over this window before going out. A burst of inbound messages must cost
 * ONE cumulative frame, not one per message: the gateway drops inbound frames above ~40/sec per
 * connection, silently and shared, so a chatty group could otherwise starve `read` and `sync`.
 */
const RECEIPT_FLUSH_DELAY_MS = 250;
/**
 * Conversations backfilled concurrently on reconnect. Sequential catch-up leaves a 500-chat user
 * "syncing" for minutes; unbounded fan-out is a self-inflicted burst against the edge limiter.
 */
const RESYNC_CONCURRENCY = 4;
/** Matches the server's hard clamp — a full page means "there is more", so keep paging. */
const BACKFILL_PAGE = 100;
/** Safety stop for the paging loop: 100 pages = 10k messages in one conversation, per resync. */
const MAX_BACKFILL_PAGES = 100;
/**
 * Grace period before a backgrounded app tears its socket down (§M13). Not zero: switching apps
 * for a few seconds is constant, and suspend-on-blur would turn every glance at the notification
 * shade into a reconnect + full catch-up. Long enough to ride out a quick switch, short enough
 * that a phone in a pocket is never holding a socket open.
 */
const BACKGROUND_SUSPEND_DELAY_MS = 30_000;

class SyncEngine {
  private socket: RealtimeSocket | null = null;
  private netUnsub: (() => void) | null = null;
  private appStateUnsub: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private receiptTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the app is backgrounded and the socket has been deliberately released. */
  private suspended = false;
  /**
   * Whether a push channel can wake us. §M13's "no background WebSocket" rule is only safe
   * BECAUSE push delivers while we sleep — without it, releasing the socket means the user
   * simply stops receiving messages the moment the app leaves the foreground. So the rule is
   * gated on the premise actually holding; `infra/push` sets this once FCM/APNs is registered.
   */
  private pushAvailable = false;
  /**
   * The conversation the user is currently looking at. Messages that land here are read the
   * instant they arrive — that is what makes the peer's ticks turn blue live, and what stops the
   * unread badge from climbing on the chat the user is staring at.
   */
  private activeConversationId: string | null = null;
  private reconnectAttempts = 0;
  /** Consecutive 4001s answered with a refresh; reset once a socket actually opens. */
  private authRefreshAttempts = 0;
  private online = false;
  private started = false;
  private stopped = true;
  private draining = false;
  /** Set when the server rate-limits a send; no drain runs before it expires. */
  private outboxCooldownUntil = 0;
  /**
   * Per conversation, the cursor a gap-probe last ran from. Deleted messages leave a permanent,
   * legitimate hole in `seq`, so a probe that comes back empty must not be repeated on every
   * later message — only a cursor that actually moved earns another.
   */
  private readonly gapProbedFrom = new Map<string, number>();
  /**
   * Resolves an account id to a display name. INJECTED by the feature layer (§M3: domain must
   * not import features), because a brand-new DM arrives as a bare account id and would
   * otherwise sit in the chat list showing a raw UUID until the next cold start.
   */
  private displayNameResolver:
    ((accountId: string) => Promise<string | undefined>) | null = null;
  /** Account ids we already tried to name — one attempt each, never a retry loop per message. */
  private readonly namedPeers = new Set<string>();
  // Ephemeral realtime (§C4/§A15) — NEVER persisted. One owned expiry timer per typing
  // conversation; `activePresencePeers` maps an open DM → the peer we're watching.
  private readonly typingTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly activePresencePeers = new Map<string, string>();
  // One-shot crash-recovery: resets outbox rows orphaned in `sending` by a prior kill.
  // The first drain awaits it so it can't claim behind a stuck row.
  private recovery: Promise<unknown> | null = null;

  /**
   * Declare that push can wake the app. Until this is true the engine keeps its socket while
   * backgrounded, because dropping it would trade battery for undelivered messages.
   */
  setPushAvailable(available: boolean): void {
    this.pushAvailable = available;
    if (!available && this.suspended) {
      // Push went away while we were asleep — come back up rather than stay deaf.
      this.suspended = false;
      this.clearSuspendTimer();
      this.connect();
      this.kickOutbox();
    }
  }

  /** Provide the profile lookup used to name a newly-arrived DM (called once, at startup). */
  setDisplayNameResolver(
    fn: (accountId: string) => Promise<string | undefined>,
  ): void {
    this.displayNameResolver = fn;
  }

  /**
   * A DM created from an inbound message is named by the sender's ACCOUNT ID, because that is all
   * the message carries. Resolve it to a real name so the chat list doesn't show a raw UUID until
   * the app is restarted.
   */
  private async nameStubConversation(
    conversationId: string,
    senderId: string,
  ): Promise<void> {
    const resolve = this.displayNameResolver;
    if (!resolve || this.namedPeers.has(senderId)) return;
    this.namedPeers.add(senderId);
    try {
      const name = (await resolve(senderId))?.trim();
      if (name) await upsertConversation(conversationId, { name });
    } catch {
      // Best-effort: the id remains as the label until the next launch resolves it.
    }
  }

  /** Push the connection state to the observable store (§5 addendum). */
  private setConnState(s: ConnectionState): void {
    useRealtimeStore.getState().setConnectionState(s);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    // Recover any send orphaned in `sending` by a previous app-kill BEFORE the first
    // drain (the drain awaits this) — otherwise that row wedges its conversation forever.
    this.recovery = recoverStuckSends().catch((e: unknown) => {
      log.warn('outbox recovery failed', { reason: String(e) });
    });
    this.netUnsub = subscribeNetwork(s => this.onNetwork(s.connected));
    // §8 addendum: detect background→foreground transitions. If the socket died silently
    // while backgrounded (common on iOS), NetInfo doesn't fire — this catches it.
    this.appStateUnsub = subscribeAppState(s => {
      if (s === 'active') {
        this.clearSuspendTimer();
        this.suspended = false;
        this.onForeground();
      } else {
        this.scheduleSuspend();
      }
    });
    // Seed the initial connectivity (the subscription only fires on CHANGES).
    void getNetworkStatus()
      .then(s => this.onNetwork(s.connected))
      .catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.netUnsub) {
      this.netUnsub();
      this.netUnsub = null;
    }
    if (this.appStateUnsub) {
      this.appStateUnsub();
      this.appStateUnsub = null;
    }
    this.clearReconnectTimer();
    this.clearOutboxTimer();
    this.clearReceiptTimer();
    this.clearSuspendTimer();
    this.suspended = false;
    this.clearAllTyping();
    this.activeConversationId = null;
    this.gapProbedFrom.clear();
    this.namedPeers.clear();
    this.activePresencePeers.clear();
    useRealtimeStore.getState().reset();
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.draining = false;
  }

  // ── connectivity ─────────────────────────────────────────────────────────
  private onNetwork(connected: boolean): void {
    const was = this.online;
    this.online = connected;
    if (this.stopped) return;
    if (connected && !was) {
      this.reconnectAttempts = 0;
      this.connect();
      this.kickOutbox();
    } else if (!connected && was) {
      // Went offline — tear the socket down and pause the outbox (no hammering).
      this.setConnState('disconnected');
      this.clearReconnectTimer();
      const s = this.socket;
      this.socket = null;
      s?.close();
      this.clearOutboxTimer();
    }
  }

  /**
   * §8 addendum: foreground recovery. If the socket died silently while the app was
   * backgrounded (common on iOS), reconnect and catch up. Single-flight: `connect()`
   * guards `if (this.socket) return`, so this never creates a duplicate socket.
   */
  private onForeground(): void {
    if (this.stopped || !this.online) return;
    if (!this.socket || !this.socket.isActive) {
      log.info('foreground resume: socket dead, reconnecting');
      this.reconnectAttempts = 0;
      this.connect();
    }
    this.kickOutbox();
  }

  // ── socket lifecycle ─────────────────────────────────────────────────────
  private connect(): void {
    if (this.stopped) return;
    if (this.suspended) return; // backgrounded: §M13 holds no socket
    if (this.socket) return; // single-flight: one socket per engine
    if (!this.online || !hasSession()) return;
    const token = getAccessToken();
    if (!token) return;
    this.clearReconnectTimer();
    this.setConnState('connecting');
    const socket = new RealtimeSocket({
      onOpen: () => {
        this.reconnectAttempts = 0;
        // The token is proven good — re-arm the 4001 refresh budget for the next expiry.
        this.authRefreshAttempts = 0;
        this.setConnState('connected');
        log.info('ws open');
      },
      onConnected: () => {
        // Re-emit anything the peer still doesn't know BEFORE the catch-up: receipts owed from
        // before the drop are the ones most likely to be showing a stale tick right now.
        this.flushReceipts();
        void this.resyncAll();
        this.kickOutbox();
      },
      onMessage: data => {
        void this.onInboundMessage(data);
      },
      onReceipt: data => {
        void this.onInboundReceipt(data);
      },
      onTyping: (data, state) => {
        this.onInboundTyping(data, state);
      },
      onPresence: data => {
        this.onInboundPresence(data);
      },
      onReconnectRequested: () => {
        this.onServerReconnect();
      },
      onClose: (code, reason) => {
        this.onSocketClose(code, reason);
      },
    });
    this.socket = socket;
    socket.connect(token, appEnv.wsUrl);
  }

  private onSocketClose(code: number, reason: string): void {
    this.socket = null;
    // Peers' "typing" is no longer trustworthy once the link drops — clear all indicators.
    this.clearAllTyping();
    log.info('ws closed', { code, reason });
    if (this.stopped) return;
    if (code === WS_CODE_UNAUTHORIZED) {
      this.setConnState('disconnected');
      void this.recoverFromUnauthorized();
      return;
    }
    if (this.online && hasSession()) {
      this.setConnState('reconnecting');
      this.scheduleReconnect();
    } else {
      this.setConnState('disconnected');
    }
  }

  /**
   * A 4001 is the gateway refusing the handshake's token. The overwhelmingly common cause is an
   * access token that EXPIRED WHILE THE APP WAS BACKGROUNDED — the token rides the connect URL,
   * so unlike REST there is no interceptor to refresh it mid-flight. Treating that as fatal is
   * what makes realtime silently dead until the user force-quits: the socket never retries, and
   * `onNetwork`/`onForeground` only reconnect on a transition that may never come.
   *
   * So: refresh once (the refresh call is single-flight), then let the normal backoff reconnect
   * with the fresh token. A genuinely revoked session fails the refresh and stays disconnected.
   */
  private async recoverFromUnauthorized(): Promise<void> {
    if (this.stopped || !this.online || !hasSession()) return;
    if (this.authRefreshAttempts >= MAX_AUTH_REFRESH_ATTEMPTS) {
      log.warn(
        'ws unauthorized (4001) — refresh exhausted, staying disconnected',
      );
      return;
    }
    this.authRefreshAttempts += 1;
    const token = await refreshAccessToken().catch(() => null);
    // The world may have moved while the refresh was in flight (stop/offline/logout).
    if (this.stopped || !this.online || !hasSession()) return;
    if (!token) {
      log.warn(
        'ws unauthorized (4001) — token refresh failed, staying disconnected',
      );
      return;
    }
    log.info('ws unauthorized (4001) — token refreshed, reconnecting');
    this.setConnState('reconnecting');
    this.reconnectAttempts = 0;
    this.scheduleReconnect();
  }

  private onServerReconnect(): void {
    // Server asked us to drain then it closes 1001. Push a final drain, close proactively,
    // and reconnect promptly (reset the backoff — this is a graceful, expected cycle).
    void this.drainOutbox();
    const s = this.socket;
    this.socket = null;
    s?.close();
    if (this.stopped || !this.online || !hasSession()) return;
    this.reconnectAttempts = 0;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const attempt = ++this.reconnectAttempts;
    const delay = backoffMs(attempt);
    log.info('ws reconnect scheduled', { attempt, delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * §M13: an app in the background holds NO WebSocket. The socket's 25s ping and watchdog, plus
   * the outbox timer, otherwise keep waking the device all night for a user who is asleep —
   * hundreds of wakeups, a socket the OS may kill silently anyway, and a battery budget blown.
   * Delivery while backgrounded is push's job; the cursor catch-up on resume is the backstop.
   */
  private scheduleSuspend(): void {
    if (this.stopped || this.suspended || this.suspendTimer !== null) return;
    // No push channel = the socket IS the delivery path. Releasing it would save battery by
    // making the app stop receiving messages, which is not a trade worth making.
    if (!this.pushAvailable) return;
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (this.stopped) return;
      this.suspended = true;
      // Flush what the peer is owed BEFORE releasing the socket — otherwise a read the user just
      // performed sits in the ledger until the next foreground.
      this.flushReceipts();
      this.clearReconnectTimer();
      this.clearOutboxTimer();
      this.clearReceiptTimer();
      this.clearAllTyping();
      const s = this.socket;
      this.socket = null;
      s?.close();
      this.setConnState('disconnected');
    }, BACKGROUND_SUSPEND_DELAY_MS);
  }

  private clearSuspendTimer(): void {
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  private clearReceiptTimer(): void {
    if (this.receiptTimer !== null) {
      clearTimeout(this.receiptTimer);
      this.receiptTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── catch-up (reconnect backfill) ────────────────────────────────────────
  /**
   * Catch up every conversation after a reconnect. Four properties are deliberate:
   *
   *  - The conversation on screen goes FIRST. Everything else can settle in the background; the
   *    one the user is staring at cannot.
   *  - Bounded concurrency, not a sequential walk. At 200 ms RTT a 500-chat user would otherwise
   *    sit in `syncing` for well over a minute before a single message appeared.
   *  - A socket drop mid-catch-up must NOT abandon the tail. The backfill is plain REST and stays
   *    valid without the socket; aborting meant that on a flapping link the far end of the
   *    conversation list was never caught up, permanently.
   *  - No per-conversation `sync` frame. The gateway only echoes that cursor back — it replays
   *    nothing — so one frame per conversation was pure noise that consumed the ~40/sec inbound
   *    budget and got real receipts dropped alongside it.
   */
  private async resyncAll(): Promise<void> {
    if (this.stopped) return;
    this.setConnState('syncing');
    let ids: string[] = [];
    try {
      ids = await listConversationIds();
    } catch {
      ids = [];
    }
    const active = this.activeConversationId;
    if (active && ids.includes(active)) {
      ids = [active, ...ids.filter(id => id !== active)];
    }

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopped) return;
        const i = next++;
        if (i >= ids.length) return;
        const id = ids[i];
        if (id === undefined) return;
        try {
          await this.backfillConversation(id);
        } catch (e) {
          log.warn('resync conversation failed', { id, reason: String(e) });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(RESYNC_CONCURRENCY, ids.length) }, worker),
    );

    // Anything the catch-up marked delivered goes out as one cumulative frame per conversation.
    this.flushReceipts();
    if (!this.stopped && this.socket) this.setConnState('live');
  }

  /**
   * Pull everything past our local cursor for one conversation, PAGING until the server runs out.
   * The server clamps `limit` to 100, so a single request silently truncates any longer gap — an
   * 8-hour absence from a busy group used to restore the oldest 100 missed messages and leave the
   * newest hundreds invisible until several more reconnect cycles happened to fill them in.
   */
  private async backfillConversation(conversationId: string): Promise<void> {
    let cursor = await maxSeqForConversation(conversationId);
    for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
      if (this.stopped) return;
      const batch = await fetchMessagesAfter(
        conversationId,
        cursor,
        BACKFILL_PAGE,
      );
      if (batch.length === 0) return;
      await applyServerMessages(batch);
      // Rows that just landed may already have been delivered/read by the peer — their receipt
      // arrived while we had nothing to apply it to. Re-apply the remembered watermark so those
      // bubbles come back with the right ticks instead of stuck grey ones.
      await this.applyPeerWatermark(conversationId);
      const highest = batch.reduce(
        (max, m) => (m.seq > max ? m.seq : max),
        cursor,
      );
      const me = getAccountId();
      const inbound = batch.filter(m => m.senderId !== me);
      if (inbound.length > 0) {
        // Received while we were away — the sender is still waiting on a second grey tick.
        this.noteDelivered(
          conversationId,
          inbound.reduce((max, m) => (m.seq > max ? m.seq : max), 0),
        );
      }
      if (highest <= cursor) return; // server isn't advancing — stop rather than spin
      cursor = highest;
      if (batch.length < BACKFILL_PAGE) return; // short page = caught up
    }
    log.warn('backfill hit the page cap — more history remains', {
      conversationId,
    });
  }

  // ── receipts (§F2/§C5) ───────────────────────────────────────────────────
  /** Re-apply what the peer already told us, for rows that only exist now. */
  private async applyPeerWatermark(conversationId: string): Promise<void> {
    const peer = getPeerWatermark(conversationId);
    try {
      if (peer.delivered > 0) {
        await applyReceipt(conversationId, peer.delivered, 'delivered');
      }
      if (peer.read > 0) await applyReceipt(conversationId, peer.read, 'read');
    } catch (e) {
      log.warn('re-apply peer receipts failed', {
        conversationId,
        reason: String(e),
      });
    }
  }

  /**
   * Record that a message is on this device. Called from BOTH receive paths — the live frame and
   * the REST catch-up — because a message that arrived while offline is just as delivered as one
   * that arrived over the socket. Only emitting from the live path is why a night in airplane mode
   * used to leave the sender on one grey tick forever, with nothing that could ever repair it.
   */
  private noteDelivered(conversationId: string, seq: number): void {
    if (noteDesired(conversationId, { delivered: seq })) {
      markDirty(conversationId);
      this.scheduleReceiptFlush();
    }
  }

  /** Record that the user has actually seen up to `seq` (blue ticks for the peer). */
  private noteRead(conversationId: string, seq: number): void {
    if (noteDesired(conversationId, { read: seq })) {
      markDirty(conversationId);
      this.scheduleReceiptFlush();
    }
  }

  private scheduleReceiptFlush(): void {
    if (this.stopped || this.suspended || this.receiptTimer !== null) return;
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = null;
      void this.flushReceipts();
    }, RECEIPT_FLUSH_DELAY_MS);
  }

  /**
   * Emit the receipts still owed, one cumulative frame per state per conversation.
   *
   * `sent` advances ONLY when the transport accepted the frame. The socket drops sends silently
   * when it isn't OPEN, so treating "we tried" as "they know" is exactly how a receipt vanishes
   * into a reconnect. Anything unsent stays dirty and is re-derived on the next flush — which the
   * reconnect path triggers, so a dropped frame costs one extra frame, never a stuck tick.
   */
  private flushReceipts(): void {
    if (this.stopped) return;
    const ids = takeDirty();
    if (ids.length === 0) return;
    for (const conversationId of ids) {
      const desired = getDesired(conversationId);
      const frames = pendingReceiptFrames(desired, getSent(conversationId));
      if (frames.length === 0) continue;
      for (const f of frames) {
        const ok = this.socket?.send(f.state, {
          conversationId,
          seq: f.upToSeq,
        });
        if (ok) {
          noteSent(conversationId, { [f.state]: f.upToSeq });
        } else {
          // Socket down or backpressured — keep it owed and retry on the next flush/reconnect.
          markDirty(conversationId);
        }
      }
    }
  }

  /**
   * The chat screen tells the engine which conversation is on screen. While a conversation is
   * active, every message that lands in it is read on arrival: the badge never climbs on a chat
   * the user is looking at, and the sender sees blue ticks without the reader touching anything.
   */
  setActiveConversation(conversationId: string | null): void {
    this.activeConversationId = conversationId;
  }

  // ── inbound frames ───────────────────────────────────────────────────────
  private async onInboundMessage(data: unknown): Promise<void> {
    const m = normalizeServerMessage(data);
    if (!m) return;
    // A new message from the peer means they've stopped typing — clear the indicator (§C4).
    this.clearTyping(m.conversationId);
    try {
      // Read the cursor BEFORE applying: once this message lands, the hole it skipped over
      // becomes invisible, and no future `afterSeq` request can ever reach back past it.
      let localMax = 0;
      try {
        localMax = await maxSeqForConversation(m.conversationId);
      } catch {
        localMax = 0;
      }
      await applyServerMessage(m);
      // Live fan-out frames are metadata-only (no body) unless the message was server-readable,
      // so an inbound frame often has no `content` → the bubble would render blank. Pull the
      // persisted message over REST (which DOES carry content) to fill it in. Best-effort.
      if (m.content === undefined || m.content === '') {
        try {
          const filled = await fetchMessagesAfter(
            m.conversationId,
            Math.max(0, m.seq - 1),
          );
          if (filled.length > 0) await applyServerMessages(filled);
        } catch {
          // best-effort: the metadata row still exists; content syncs on next catch-up
        }
      }
      // The push skipped ahead of what we hold — the messages in between were dropped by
      // best-effort fan-out, and REST is the only way they can still be recovered.
      if (
        shouldProbeGap({
          localMax,
          incomingSeq: m.seq,
          lastProbedFrom: this.gapProbedFrom.get(m.conversationId),
        })
      ) {
        this.gapProbedFrom.set(m.conversationId, localMax);
        try {
          await this.backfillConversation(m.conversationId);
        } catch (e) {
          log.warn('gap backfill failed', {
            conversationId: m.conversationId,
            reason: String(e),
          });
        }
      }
      if (m.senderId !== getAccountId()) {
        void this.nameStubConversation(m.conversationId, m.senderId);
        this.noteDelivered(m.conversationId, m.seq);
        // Landed in the chat the user is currently reading → it is read, now. Clearing the badge
        // here is what stops it from climbing on the open conversation, and the read watermark is
        // what turns the sender's ticks blue while they watch.
        if (this.activeConversationId === m.conversationId) {
          this.noteRead(m.conversationId, m.seq);
          try {
            await clearUnread(m.conversationId);
          } catch {
            // badge cosmetics only — never fail the inbound path over it
          }
        }
      }
    } catch (e) {
      log.warn('apply inbound message failed', { reason: String(e) });
    }
  }

  private async onInboundReceipt(data: unknown): Promise<void> {
    const d =
      data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const conversationId =
      typeof d.conversationId === 'string'
        ? d.conversationId
        : typeof d.conversation_id === 'string'
          ? d.conversation_id
          : undefined;
    const seqRaw = d.upToSeq ?? d.up_to_seq ?? d.seq;
    const upToSeq = typeof seqRaw === 'number' ? seqRaw : Number(seqRaw);
    const state =
      d.state === 'read'
        ? 'read'
        : d.state === 'delivered'
          ? 'delivered'
          : undefined;
    if (
      conversationId === undefined ||
      !Number.isFinite(upToSeq) ||
      state === undefined
    ) {
      return;
    }
    // Remember it even if it matches nothing right now: a receipt for messages we have not
    // backfilled yet used to evaporate, leaving permanent grey ticks on messages the peer had
    // already read. The backfill re-applies this watermark once those rows exist.
    notePeerWatermark(conversationId, { [state]: upToSeq });
    try {
      await applyReceipt(conversationId, upToSeq, state);
    } catch (e) {
      log.warn('apply receipt failed', { reason: String(e) });
    }
  }

  // ── outbox worker ────────────────────────────────────────────────────────
  private kickOutbox(): void {
    if (this.stopped || this.suspended) return;
    void this.drainOutbox();
  }

  private async drainOutbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      // Never claim before crash-recovery has un-stuck orphaned `sending` rows.
      if (this.recovery) await this.recovery;
      for (;;) {
        if (this.stopped || !this.online || !hasSession()) break;
        // Rate limited a moment ago — walking the queue now just re-earns the 429 and burns an
        // attempt on every message behind it.
        if (Date.now() < this.outboxCooldownUntil) break;
        const item = await claimNextDue(Date.now());
        if (!item) break;
        try {
          const ack = await sendChatMessage(item.input);
          await markMessageSent(item.clientMsgId, ack);
          await markAckd(item.id);
        } catch (e) {
          const attempts = item.attempts + 1;
          const msg = isAppError(e) ? e.message : String(e);
          // The CAUSE decides, not the attempt count: unreachable keeps the clock icon forever,
          // a refusal of this message surfaces the retry affordance immediately.
          const decision = classifySendFailure(e, attempts);
          await markFailed(item.id, msg, attempts, decision.permanent);
          if (decision.permanent) await markMessageFailed(item.clientMsgId);
          if (decision.cooldownMs > 0) {
            this.outboxCooldownUntil = Date.now() + decision.cooldownMs;
          }
          if (decision.pauseDrain) break;
        }
      }
    } finally {
      this.draining = false;
      void this.scheduleOutbox();
    }
  }

  /** Self-adjusting timer: schedule the next drain at the earliest due time, else stay idle. */
  private async scheduleOutbox(): Promise<void> {
    this.clearOutboxTimer();
    if (this.stopped || !this.online || this.suspended) return;
    let stats: { queued: number; nextDueAt: number | null };
    try {
      stats = await outboxStats();
    } catch {
      return;
    }
    if (stats.queued === 0) return; // idle — nothing to poll for
    const now = Date.now();
    // Never wake before a rate-limit cooldown expires, however soon the row claims to be due.
    const dueAt = Math.max(stats.nextDueAt ?? now, this.outboxCooldownUntil);
    const delay = Math.max(
      OUTBOX_MIN_DELAY_MS,
      Math.min(OUTBOX_MAX_DELAY_MS, dueAt - now),
    );
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = null;
      void this.drainOutbox();
    }, delay);
  }

  private clearOutboxTimer(): void {
    if (this.outboxTimer !== null) {
      clearTimeout(this.outboxTimer);
      this.outboxTimer = null;
    }
  }

  // ── public send ──────────────────────────────────────────────────────────
  /**
   * Optimistic send (§L7): write the `sending` bubble to the DB (instant UI), enqueue the
   * durable outbox item, and kick the worker. Never blocks the render path — the outbox
   * transmits + reconciles the ack, even across a mid-send crash + relaunch.
   */
  async sendText(
    conversationId: string,
    senderId: string,
    text: string,
  ): Promise<void> {
    // ONE transaction for the bubble + its outbox row: a crash between two writes used to strand
    // a message in `sending` that nothing would ever transmit or surface as failed.
    const clientMsgId = await enqueueOptimisticSend(
      conversationId,
      text,
      senderId,
    );
    if (!clientMsgId) return;
    this.kickOutbox();
  }

  /**
   * Pull the page of history immediately BEFORE what we hold (§L7 "load older").
   *
   * The API is forward-only — there is no `before` parameter — but `afterSeq` is a free cursor,
   * so asking from `oldestHeld - 1 - page` and taking a page reaches back correctly. Returns
   * whether anything new landed, so the UI only grows its window when there is more to show.
   */
  async loadOlderMessages(
    conversationId: string,
    page: number,
  ): Promise<boolean> {
    const oldest = await minSeqForConversation(conversationId);
    if (oldest <= 1) return false; // seq 1 is the first message ever — nothing precedes it
    const from = Math.max(0, oldest - 1 - page);
    const older = await fetchMessagesAfter(conversationId, from, page);
    const fresh = older.filter(m => m.seq < oldest);
    if (fresh.length === 0) return false;
    await applyServerMessages(fresh);
    return true;
  }

  /**
   * The user opened a conversation → clear its unread badge locally and tell the server we
   * read up to the latest seq we hold (§F2/§5). Best-effort: the read frame only goes out
   * when the socket is up; the local badge clears regardless (offline-first).
   */
  async markConversationRead(conversationId: string): Promise<void> {
    await clearUnread(conversationId);
    try {
      const seq = await maxSeqForConversation(conversationId);
      // Record it even with the socket down: the ledger is durable, so opening a chat offline
      // still turns the sender's ticks blue as soon as we reconnect.
      if (seq > 0) this.noteRead(conversationId, seq);
    } catch {
      // a missing cursor just means no read frame this time — the badge already cleared
    }
  }

  /**
   * Manual retry of a permanently-failed send (§L6): flip the bubble back to `sending`,
   * re-arm the outbox row, and kick the worker. Re-send is idempotent (same clientMsgId).
   */
  async retrySend(clientMsgId: string): Promise<void> {
    const requeued = await requeueFailed(clientMsgId);
    if (!requeued) return;
    await markMessageSending(clientMsgId);
    this.kickOutbox();
  }

  // ── typing (§C4) ───────────────────────────────────────────────────────────
  /**
   * Tell the server I'm typing / stopped (ephemeral, best-effort). The gateway reads these fields
   * at the frame's TOP LEVEL (`sendEphemeral` sends a FLAT `{kind:'ephemeral',type:'typing',…}`),
   * then relays `typing.started`/`typing.stopped` to the OTHER members. Dropped when offline — that
   * is fine (§C4: typing is never re-synced).
   */
  sendTyping(conversationId: string, state: 'start' | 'stop'): void {
    this.socket?.sendEphemeral('typing', { conversationId, state });
  }

  /** Inbound `typing.started`/`typing.stopped` → the live store, with an owned auto-expire timer. */
  private onInboundTyping(data: unknown, state: 'start' | 'stop'): void {
    const d =
      data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const conversationId =
      typeof d.conversationId === 'string'
        ? d.conversationId
        : typeof d.conversation_id === 'string'
          ? d.conversation_id
          : undefined;
    const userId =
      typeof d.userId === 'string'
        ? d.userId
        : typeof d.user_id === 'string'
          ? d.user_id
          : typeof d.account_id === 'string'
            ? d.account_id
            : undefined;
    if (conversationId === undefined || userId === undefined) return;
    if (state === 'stop') {
      this.clearTyping(conversationId);
      return;
    }
    useRealtimeStore
      .getState()
      .setTyping(conversationId, userId, Date.now() + TYPING_TTL_MS);
    // Owned expiry timer (§M7): replace any existing one so the indicator self-clears if no
    // refresh / `stop` / message arrives within the TTL (the store change re-renders it away).
    const existing = this.typingTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    this.typingTimers.set(
      conversationId,
      setTimeout(() => {
        this.typingTimers.delete(conversationId);
        useRealtimeStore.getState().clearTyping(conversationId);
      }, TYPING_TTL_MS),
    );
  }

  /** Clear one conversation's typing indicator + cancel its expiry timer. */
  private clearTyping(conversationId: string): void {
    const timer = this.typingTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(conversationId);
    }
    useRealtimeStore.getState().clearTyping(conversationId);
  }

  /** Cancel every typing timer + drop all indicators (socket drop / engine stop). */
  private clearAllTyping(): void {
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    useRealtimeStore.getState().resetTyping();
  }

  // ── presence (§A15) ────────────────────────────────────────────────────────
  /**
   * A chat became active → resolve its DM peer (members − me), subscribe to the peer's live presence
   * (fan-out targets subscribers only), and fetch the current snapshot into the store. Returns the
   * peerId, or `null` for a group / note-to-self (no single-peer presence line). Never blocks the UI:
   * every network call is best-effort and off the render path.
   */
  async activatePresence(conversationId: string): Promise<string | null> {
    const me = getAccountId();
    if (!me) return null;
    let peerId: string | null = null;
    try {
      const members = await getConversationMembers(conversationId);
      const others = members.filter(m => m !== me);
      peerId = others.length === 1 ? (others[0] ?? null) : null;
    } catch (e) {
      log.warn('presence members resolve failed', { reason: String(e) });
      return null;
    }
    if (peerId === null) return null;
    this.activePresencePeers.set(conversationId, peerId);
    const peer = peerId;
    void subscribePresence(me, [peer]).catch((e: unknown) => {
      log.warn('presence subscribe failed', { reason: String(e) });
    });
    try {
      const p = await getPresence(peer, me);
      useRealtimeStore.getState().setPresence(peer, {
        status: normalizePresenceStatus(p.status),
        lastSeen: p.lastSeen,
      });
    } catch (e) {
      log.warn('presence fetch failed', { reason: String(e) });
    }
    return peer;
  }

  /** A chat closed → stop tracking its peer (the last-known snapshot may stay in the store). */
  deactivatePresence(conversationId: string): void {
    this.activePresencePeers.delete(conversationId);
  }

  /** Inbound live presence frame (`presence`/`presence.changed`) → the store. */
  private onInboundPresence(data: unknown): void {
    const ev = normalizePresenceEvent(data);
    if (!ev) return;
    useRealtimeStore.getState().setPresence(ev.userId, {
      status: normalizePresenceStatus(ev.status),
      lastSeen: ev.lastSeen,
    });
  }

  /**
   * §26 addendum: development-time runtime diagnostics. Exposes a non-sensitive snapshot
   * of the engine's internal state for debugging. Never exposes tokens, content, or credentials.
   */
  getDiagnostics(): {
    connectionState: ConnectionState;
    socketActive: boolean;
    reconnectAttempts: number;
    online: boolean;
    started: boolean;
    stopped: boolean;
    draining: boolean;
    outboxTimerActive: boolean;
    reconnectTimerActive: boolean;
    activePresencePeers: number;
    typingTimers: number;
  } {
    return {
      connectionState: useRealtimeStore.getState().connectionState,
      socketActive: this.socket?.isActive ?? false,
      reconnectAttempts: this.reconnectAttempts,
      online: this.online,
      started: this.started,
      stopped: this.stopped,
      draining: this.draining,
      outboxTimerActive: this.outboxTimer !== null,
      reconnectTimerActive: this.reconnectTimer !== null,
      activePresencePeers: this.activePresencePeers.size,
      typingTimers: this.typingTimers.size,
    };
  }
}

/** The app-wide singleton (§L6). Started at the root; owns all sync resources. */
export const syncEngine = new SyncEngine();

/** Start the engine app-wide (call once on mount at the root). */
export function startSync(): void {
  syncEngine.start();
}

/** Stop + fully dispose the engine (call on root unmount). */
export function stopSync(): void {
  syncEngine.stop();
}
