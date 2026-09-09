/**
 * The push runtime (ADR 0008) — where a notification action becomes a real change.
 *
 * ## Why this lives in `features/` and not in `infra/push`
 *
 * Finishing any of these actions needs the whole stack: a reply goes through the outbox and its
 * retry policy, a mute has to reach `PUT /notifications/prefs` with a bearer token, a read has
 * to clear the local badge and advance a durable watermark. `infra/push` cannot reach `domain/`
 * without closing an `infra → domain → infra` cycle through the barrels (§M3), so it publishes
 * events and this slice acts on them.
 *
 * ## What native already did before we got here
 *
 * Native sends the **delivery receipt** itself, because that is the one thing it can authenticate
 * with the push token alone — and doing it from Kotlin is the only way a CLOSED app can produce
 * a second tick at all. Reply and Mark-as-read also send their `read` receipt natively, so the
 * sender's tick turns blue at the moment of the tap rather than at next app launch. What arrives
 * here is the remainder: the part that needs the user's session.
 *
 * Every handler is therefore written to be safe to run LATE and MORE THAN ONCE. An event can be
 * delivered minutes after the tap (the queue survives a process kill), and the receipt half may
 * already have been sent. Sends are idempotent by `clientMsgId`; reads and mutes are monotonic.
 */
import { log } from '../../../core';
import {
  takeQueuedPushEvents,
  getAccountId,
  initPush,
  setNativeMute,
  subscribePushAvailability,
  subscribePushEvents,
  subscribePushMessages,
  unregisterPush,
  syncConversationNames,
  syncPersonNames,
  syncPersonAvatars,
  observeConversations,
  outboxStats,
  refreshSession,
  getRefreshToken,
  accessTokenExpiresInMs,
  kv,
  KVKeys,
  subscribeSession,
  type PushPendingEvent,
} from '../../../infra';
import { syncEngine } from '../../../domain/sync';
import { setConversationMute } from '../api/prefs';

/** How many conversation names to mirror natively. Bounded — this is a notification title. */
const NAME_MIRROR_LIMIT = 200;

/**
 * Refresh the session before acting if the access token has less than this left.
 *
 * Not a guess at clock skew — it is the cost of being wrong. A token with a few seconds on it
 * expires mid-request, and the woken process learns that from a 401 it cannot afford.
 */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

/**
 * How long to wait before the second flush. Long enough for a radio that was asleep when the
 * push landed to have finished attaching, short enough to stay inside the wake window.
 */
const RETRY_FLUSH_DELAY_MS = 1_500;

let unsubEvents: (() => void) | null = null;
let unsubAvailability: (() => void) | null = null;
let unsubMessages: (() => void) | null = null;
let unsubSession: (() => void) | null = null;
let namesSub: { unsubscribe: () => void } | null = null;

/**
 * Handlers still running, so a headless wake can await the work it triggered instead of letting
 * the OS tear the process down mid-send.
 */
const inflight = new Set<Promise<unknown>>();

/**
 * Install the ONE event handler for this JS context.
 *
 * Single-owner by construction. Both entry points call it — the app's mount effect and the
 * headless wake — and they can genuinely coincide if a React context comes alive in the window
 * between native checking for one and starting the service. Two subscriptions would each receive
 * the same drained batch, and "each reply is sent twice" is a message-correctness bug, not a
 * cosmetic one.
 */
function installEventHandler(): void {
  if (unsubEvents) return;
  unsubEvents = subscribePushEvents(event => {
    const work = handlePushEvent(event).catch(err => {
      log.warn('push action failed', { type: event.type, reason: String(err) });
    });
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  });
}

/**
 * Bring push up and keep the SyncEngine honest about it.
 *
 * Order matters: the event subscription is installed BEFORE `initPush()`, because `initPush`
 * drains the native queue and the drain is what delivers the batch. Subscribing afterwards would
 * miss every action taken since the app was last alive — exactly the actions that most need
 * applying.
 */
export function startPushRuntime(): void {
  installEventHandler();
  if (unsubAvailability) return; // idempotent: called from a mount effect and after sign-in

  /**
   * The §M13 contract: the engine may only drop its background socket once push can genuinely
   * wake us. `subscribePushAvailability` fires immediately with the current value, so this is
   * correct even though push initialises asynchronously.
   */
  unsubAvailability = subscribePushAvailability(available => {
    syncEngine.setPushAvailable(available);
  });

  /**
   * A push that lands while JS is alive. The socket usually beats it, but not always — a
   * backgrounded app whose socket was suspended learns about the message here first, and
   * `noteInboundDelivered` is what stops it waiting for the next foreground to find out.
   */
  unsubMessages = subscribePushMessages(message => {
    if (!message.conversationId) return;
    if (message.seq !== undefined && message.seq > 0) {
      syncEngine.noteInboundDelivered(message.conversationId, message.seq);
    }
    void syncEngine.resyncNow();
  });

  startNameMirror();
  void initPush();

  // Re-register push when the user signs in while the app is already running.
  // initPush() runs once at mount, but if no session exists yet (fresh install / after
  // sign-out) it defers registration. This listener fills that gap — identical to how
  // the SyncEngine re-opens its socket on session establishment (§L6).
  if (!unsubSession) {
    unsubSession = subscribeSession(present => {
      if (present) void initPush();
    });
  }
}

/** §M7: release everything this module owns. */
export function stopPushRuntime(): void {
  unsubEvents?.();
  unsubAvailability?.();
  unsubMessages?.();
  unsubSession?.();
  namesSub?.unsubscribe();
  unsubEvents = null;
  unsubAvailability = null;
  unsubMessages = null;
  unsubSession = null;
  namesSub = null;
}

/**
 * Sign-out. Must run BEFORE `clearSession()` — un-registering needs the bearer token that is
 * about to be thrown away, and the body needs the account/device ids.
 */
export async function shutdownPushForSignOut(): Promise<void> {
  stopPushRuntime();
  syncEngine.setPushAvailable(false);
  await unregisterPush();
}

/**
 * Mirror `conversationId -> display name` into native storage.
 *
 * Without this a notification posted by a killed app can only say "VelChat", because the server
 * sends ids and nothing else (§A19). Driven off the existing chat-list observation rather than a
 * timer, so it is already up to date whenever the list changes and costs nothing when it does not.
 */
function startNameMirror(): void {
  if (namesSub) return;
  try {
    namesSub = observeConversations(NAME_MIRROR_LIMIT).subscribe(rows => {
      const names: Record<string, string> = {};
      const people: Record<string, string> = {};
      const faces: Record<string, string> = {};
      for (const row of rows) {
        const name = row.name?.trim();
        if (!name) continue;
        names[row.id] = name;
        // A DM's title IS the other person, so this doubles as their display name — which is
        // what lets a notification attribute the message to a sender rather than to nobody.
        // Group members are not covered here and fall back to the conversation's own name.
        if (row.peerId) people[row.peerId] = name;
        // The same row already carries the peer photo the chat list draws, so mirroring it costs
        // one more map and no extra query. Native caches it to a file from here — the push path
        // cannot fetch anything.
        if (row.peerId && row.peerAvatarUrl)
          faces[row.peerId] = row.peerAvatarUrl;
      }
      // Our OWN photo, under our own account id.
      //
      // A notification thread shows both sides once the user replies inline, and without this
      // their own line was the only one with no face on it. The native side looks it up by the
      // account id it already stores for the ack credential, so this needs no new plumbing.
      const me = getAccountId();
      const mine = kv.getString(KVKeys.avatarUrl);
      if (me && mine) faces[me] = mine;
      syncConversationNames(names);
      syncPersonNames(people);
      syncPersonAvatars(faces);
    });
  } catch {
    // No DB yet (first launch, before the adapter opens). Notifications fall back to a generic
    // title; the next launch mirrors them.
  }
}

async function handlePushEvent(event: PushPendingEvent): Promise<void> {
  switch (event.type) {
    case 'reply': {
      const me = getAccountId();
      if (!me) {
        // Signed out between the tap and the drain. Sending as nobody would fail the server's
        // sender check and strand the bubble as permanently failed — better to drop it.
        log.info('push: dropping queued reply, no account');
        return;
      }
      // Goes through the ordinary optimistic-send path: the bubble appears in the chat, the
      // outbox transmits it, and a mid-send kill is recovered like any other send.
      await syncEngine.sendText(event.conversationId, me, event.text);
      // Replying is reading. The receipt was already sent natively; this clears the local badge
      // and advances the durable watermark so a reconnect does not undo it.
      await syncEngine.markConversationRead(event.conversationId);
      return;
    }

    case 'read':
      await syncEngine.markConversationRead(event.conversationId);
      return;

    case 'mute': {
      const me = getAccountId();
      // Keep the native mute regardless — it is what actually silences the device — but the
      // server pref is what stops the push being SENT, and only this side can write it.
      setNativeMute(event.conversationId, event.mutedUntil);
      if (!me) return;
      await setConversationMute(me, event.conversationId, event.mutedUntil);
      return;
    }

    case 'token':
      // FCM rotated our token while JS was dead, so the backend is pointing at a token that no
      // longer exists. Re-run registration; `initPush` is idempotent and single-flight.
      await initPush();
      return;

    case 'resync':
      // FCM dropped messages for this device. There are no ids left to act on — a cursor sync
      // is the only thing that recovers them, and without it they would surface only when the
      // user happened to open the app.
      await syncEngine.resyncNow();
      return;
  }
}

/**
 * The headless wake (`PushHeadlessService` → `AppRegistry.registerHeadlessTask`).
 *
 * Runs when the user replied to or muted a notification with NO app process alive. The task is
 * bounded at 30 s by the service, so this resolves only once the work is genuinely done —
 * returning early would let the OS tear the process down with a reply still in the outbox.
 *
 * The final flush is the part that matters: `sendText` writes the bubble and the durable outbox
 * row, but the outbox worker is gated on a started, online engine and neither is true here. See
 * `SyncEngine.flushOutboxNow`.
 */
export async function runQueuedPushActions(): Promise<void> {
  // Deliberately NOT `installEventHandler` + `drainPendingEvents`.
  //
  // That route applied each event through a subscription and then awaited a snapshot of whatever
  // promises the listener had started by then — so whether this task waited for the reply at all
  // came down to timing. On a device it declared the handlers done 38 ms after the drain, which is
  // not long enough for the two SQLite writes a reply performs, and the send then completed 600 ms
  // AFTER the task ended and the service stopped. It arrived only because the process happened not
  // to be reaped yet; on the user's phone it was, and the reply left when the app was next opened.
  //
  // Taking the events and awaiting each one removes the timing from the picture: when this
  // function resolves, the work is genuinely finished.
  // BEFORE anything is sent. A woken process gets one bounded window, and an access token that
  // has already expired turns the reply into 401 -> refresh -> retry inside it. On a phone on
  // mobile data that chain does not always finish: the failure classifies as transient, which
  // PAUSES the outbox drain, and the reply then leaves only when the user next opens the app —
  // which is exactly what a reply button is supposed to save them from. Refreshing first spends
  // one round trip instead of three.
  await refreshIfExpiring();
  const events = await takeQueuedPushEvents();
  if (events.length > 0) {
    log.info('push: applying queued notification actions', {
      count: events.length,
    });
  }
  // Sequentially, and each one awaited. `allSettled` over the results rather than a bare loop so
  // one failing action cannot abandon the rest — a reply must still go out if a mute failed.
  const outcomes = await Promise.allSettled(
    events.map(event => () => handlePushEvent(event)).map(run => run()),
  );
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome?.status === 'rejected') {
      log.warn('push action failed', {
        type: events[i]?.type,
        reason: String(outcome.reason),
      });
    }
  }
  log.info('push: handlers done, flushing the outbox');
  await syncEngine.flushOutboxNow();
  log.info('push: outbox flushed');

  // One more pass, if anything is still queued.
  //
  // A single transient failure pauses the whole drain (`sendFailurePolicy`), so without this the
  // reply waits for the next launch. The retry is bounded and cheap: it runs only when something
  // is actually still queued, and the wake window has room for it.
  try {
    const stats = await outboxStats();
    if (stats.queued > 0) {
      log.info('push: outbox still has work after the first flush', {
        queued: stats.queued,
      });
      await new Promise(resolve => setTimeout(resolve, RETRY_FLUSH_DELAY_MS));
      await syncEngine.flushOutboxNow();
    }
  } catch (err) {
    log.info('push: could not re-check the outbox', { reason: String(err) });
  }

  // The task's last act, so a device log can say WHERE it ended.
  //
  // Without this, a capture showed the task starting, the database being touched, and then
  // silence — and the foreground service stopping 187 ms later was consistent with two completely
  // different stories: the task finishing early, or the OS pulling the service out from under a
  // task that was still working. Those need opposite fixes, and nothing in the log chose between
  // them. It does now.
  log.info('push: queued actions complete');
}

/**
 * Refresh the session if the access token is gone or about to be.
 *
 * The margin is generous on purpose: a token with four seconds left will expire mid-request, and
 * the wake window cannot afford to find that out from the server.
 */
async function refreshIfExpiring(): Promise<void> {
  if (!getRefreshToken()) return; // signed out, or nothing to refresh with
  if (accessTokenExpiresInMs() > ACCESS_TOKEN_MARGIN_MS) return;
  try {
    const outcome = await refreshSession();
    log.info('push: refreshed the session before acting', {
      outcome: outcome.status,
    });
  } catch (err) {
    // Not fatal. The send still tries, and the interceptor still has its own 401 path.
    log.info('push: pre-emptive refresh failed', { reason: String(err) });
  }
}
