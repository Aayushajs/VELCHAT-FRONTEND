/**
 * Push orchestration (§M14) — the layer that turns "the OS gave us a token" into "the SyncEngine
 * may sleep" (§M13).
 *
 * Owns exactly three long-lived subscriptions (token refresh, inbound message, app foreground)
 * and disposes all of them in `disposePush()` (§M7). Every entry point is idempotent, because
 * they are called from a mount effect, from login, and from a token-refresh callback that can
 * all land at once.
 *
 * What this module deliberately does NOT do:
 *  - It never REQUESTS notification permission. Prompts are contextual (§M23) and belong to the
 *    onboarding screen; this only observes the answer.
 *  - It never calls into `domain/`. Availability is published through
 *    `subscribePushAvailability`, which `app/App.tsx` wires to `syncEngine.setPushAvailable`.
 *    A direct import would close an `infra → domain → infra` cycle through the barrels.
 */
import { Platform } from 'react-native';
import { appEnv, log } from '../../core';
import { kv } from '../kv';
import { getAccountId, getDeviceId } from '../network';
import { hasNotificationPermission, subscribeAppState } from '../native';
import { clearPushEndpoint, registerPushEndpoint } from './api';
import { collapsePendingEvents } from './pendingEvents';
import { nativePush } from './nativePush';
import {
  INITIAL_PUSH_STATUS,
  isPushAvailable,
  reducePush,
  registrationKey,
  shouldRegister,
} from './pushState';
import type {
  PushEvent,
  PushMessage,
  PushPendingEvent,
  PushStatus,
} from './types';

/**
 * Persisted registration lease. Without it every cold start re-POSTs an unchanged endpoint; with
 * it we skip the call entirely. The timestamp makes it a LEASE rather than a permanent claim, so
 * a row pruned server-side heals on the next launch after it expires instead of never.
 *
 * Raw string key (not `KVKeys`) only because `infra/kv` is outside this change's lane — it should
 * move into `KVKeys` next time that file is touched.
 */
const KV_REGISTRATION = 'push.registration.v1';
const REGISTRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredRegistration {
  key: string;
  at: number;
}

function readStoredRegistration(): StoredRegistration | null {
  const raw = kv.getString(KV_REGISTRATION);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRegistration>;
    if (typeof parsed.key !== 'string' || typeof parsed.at !== 'number') {
      return null;
    }
    if (Date.now() - parsed.at > REGISTRATION_TTL_MS) return null; // lease expired
    return { key: parsed.key, at: parsed.at };
  } catch {
    return null;
  }
}

function writeStoredRegistration(key: string): void {
  kv.set(KV_REGISTRATION, JSON.stringify({ key, at: Date.now() }));
}

function forgetStoredRegistration(): void {
  kv.delete(KV_REGISTRATION);
}

// ── state ────────────────────────────────────────────────────────────────────

let status: PushStatus = INITIAL_PUSH_STATUS;
let lastPublishedAvailability: boolean | null = null;

const availabilityListeners = new Set<(available: boolean) => void>();
const messageListeners = new Set<(message: PushMessage) => void>();
const eventListeners = new Set<(event: PushPendingEvent) => void>();

/** Owned subscriptions — every one of these is released by `disposePush()`. */
let unsubToken: (() => void) | null = null;
let unsubMessage: (() => void) | null = null;
let unsubAppState: (() => void) | null = null;
let unsubPending: (() => void) | null = null;

/** Single-flight for the queue drain — see `drainPendingEvents`. */
let draining: Promise<void> | null = null;

/** Single-flight guard so a mount effect and a login cannot register twice in parallel. */
let inFlight: Promise<void> | null = null;

function apply(event: PushEvent): void {
  const next = reducePush(status, event);
  if (next === status) return;
  status = next;
  publishAvailability();
}

function publishAvailability(): void {
  const available = isPushAvailable(status);
  if (available === lastPublishedAvailability) return;
  lastPublishedAvailability = available;
  log.info('push availability changed', { available, phase: status.phase });
  for (const listener of availabilityListeners) {
    try {
      listener(available);
    } catch (err) {
      log.warn('push availability listener threw', { reason: String(err) });
    }
  }
}

/** The current push state. Diagnostics only — never contains anything loggable as PII. */
export function getPushStatus(): Omit<PushStatus, 'token'> & {
  hasToken: boolean;
} {
  const { token, ...rest } = status;
  return { ...rest, hasToken: token !== null };
}

/**
 * Observe whether push can wake this app. Fires IMMEDIATELY with the current value, then on
 * every change — so a late subscriber cannot miss the transition that already happened.
 * Returns an unsubscribe.
 */
export function subscribePushAvailability(
  cb: (available: boolean) => void,
): () => void {
  availabilityListeners.add(cb);
  try {
    cb(isPushAvailable(status));
  } catch (err) {
    log.warn('push availability listener threw', { reason: String(err) });
  }
  return () => availabilityListeners.delete(cb);
}

/** Observe data pushes that arrive while a JS context is alive. Returns an unsubscribe. */
export function subscribePushMessages(
  cb: (message: PushMessage) => void,
): () => void {
  messageListeners.add(cb);
  return () => messageListeners.delete(cb);
}

/**
 * Observe actions the user took on a notification — Reply, Mark as read, Mute — plus the two
 * housekeeping events native can raise (`token`, `resync`).
 *
 * Subscribe BEFORE calling `initPush()`. Each event is delivered exactly once, and the native
 * queue is emptied by the drain that produces it, so a listener attached afterwards can miss a
 * batch entirely. `features/push` owns the handler; this layer must not reach into `domain/`.
 */
export function subscribePushEvents(
  cb: (event: PushPendingEvent) => void,
): () => void {
  eventListeners.add(cb);
  return () => eventListeners.delete(cb);
}

/**
 * Drain the native queue of notification actions and hand them to the listeners.
 *
 * Single-flight, because three things call it — init, the native `pending` signal, and every
 * foreground — and they routinely overlap. Two concurrent drains would not double-apply (the
 * native side hands each entry to exactly one caller) but the second would return empty and
 * look like the queue was already handled, which is a confusing thing to debug.
 *
 * Events are collapsed first: redundant read watermarks and mutes for one conversation become
 * one apply each, while replies keep their order and their count.
 */
export function drainPendingEvents(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    try {
      const events = collapsePendingEvents(
        await nativePush.takePendingEvents(),
      );
      if (events.length === 0) return;
      log.info('push: applying queued notification actions', {
        count: events.length,
      });
      for (const event of events) {
        for (const listener of eventListeners) {
          try {
            listener(event);
          } catch (err) {
            // One bad handler must not swallow the rest of the batch — these are already
            // drained natively, so a thrown listener would lose the remaining events.
            log.warn('push event listener threw', { reason: String(err) });
          }
        }
      }
    } catch (err) {
      log.warn('push: drain failed', { reason: String(err) });
    } finally {
      draining = null;
    }
  })();
  return draining;
}

/**
 * Mirror conversation display names into native storage so a notification posted by a killed
 * app can name the chat instead of saying "VelChat". The push carries ids only (§A19).
 *
 * Best-effort and cheap; call it whenever the chat list is refreshed.
 */
export function syncConversationNames(
  names: Readonly<Record<string, string>>,
): void {
  if (Object.keys(names).length === 0) return;
  void nativePush.setConversationNames(names);
}

/** Keep the native mute in step with a pref set inside the app. `0` clears it. */
export function setNativeMute(
  conversationId: string,
  untilMillis: number,
): void {
  void nativePush.setMuted(conversationId, untilMillis);
}

/** The user opened a chat — drop its notification rather than leave a stale one in the tray. */
export function clearConversationNotification(conversationId: string): void {
  void nativePush.clearConversationNotification(conversationId);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

function installListeners(): void {
  if (!unsubToken) {
    unsubToken = nativePush.onTokenRefresh(token => {
      // The OS rotated our token. Re-register under the new one — the old one is dead the
      // moment this fires, so skipping it means silently losing push until the next cold start.
      log.info('push token rotated');
      apply({ type: 'token', token });
      void syncRegistration();
    });
  }
  if (!unsubMessage) {
    unsubMessage = nativePush.onMessage(message => {
      for (const listener of messageListeners) {
        try {
          listener(message);
        } catch (err) {
          log.warn('push message listener threw', { reason: String(err) });
        }
      }
    });
  }
  if (!unsubPending) {
    unsubPending = nativePush.onPendingEvents(() => {
      void drainPendingEvents();
    });
  }
  if (!unsubAppState) {
    unsubAppState = subscribeAppState(state => {
      // Permission can be revoked from Settings while we sleep. Re-check on every foreground:
      // if it is gone, availability must drop so the SyncEngine stops trusting push.
      if (state !== 'active') return;
      void refreshPermission();
      // A signal emitted while JS was dead is gone; the queue is not. Foreground is the
      // backstop that guarantees a reply typed into a notification eventually sends.
      void drainPendingEvents();
    });
  }
}

/**
 * Hand native the credentials a woken, JS-less process needs to acknowledge delivery.
 *
 * Called after every successful registration and on every session change, because all three
 * parts can move independently: the base URL with the build, the device id with a reinstall,
 * the account with a sign-in.
 */
function mirrorCredentials(): void {
  const accountId = getAccountId();
  const deviceId = getDeviceId();
  if (!accountId || !deviceId) return;
  void nativePush.setCredentials(appEnv.apiBaseUrl, deviceId, accountId);
}

async function refreshPermission(): Promise<void> {
  if (status.phase === 'unsupported') return;
  const granted = await hasNotificationPermission();
  const before = status.phase;
  apply({ type: 'permission', permission: granted ? 'granted' : 'denied' });
  // A re-grant resets the machine to `idle` — register again on the spot rather than making
  // the user relaunch the app to get push back.
  if (granted && before === 'denied') void syncRegistration();
}

/**
 * Get a token if we can, and make sure the backend holds it for the CURRENT account.
 * Safe to call at any time; does nothing when there is nothing to do.
 */
async function syncRegistration(): Promise<void> {
  if (status.phase === 'unsupported' || status.permission !== 'granted') return;

  if (status.token === null) {
    const token = await nativePush.getToken();
    apply({ type: 'token', token });
    if (token === null) return;
  }
  const token = status.token;
  if (token === null) return;

  const accountId = getAccountId();
  const deviceId = getDeviceId();
  if (!accountId || !deviceId) {
    // Signed out, or provisioning has not finished. The backend keys the endpoint by BOTH, so
    // there is nothing meaningful to register yet; login calls back in here.
    log.info('push: no account/device yet — registration deferred');
    return;
  }

  const key = registrationKey(accountId, deviceId, token);

  // Unconditionally, before the lease check: a cold start that SKIPS the network call still has
  // to re-mirror these, because native storage can be cleared independently of ours (app data
  // partially wiped, a restore from backup). Skipping it there is how a device ends up
  // registered for push yet unable to acknowledge a single delivery.
  mirrorCredentials();

  // A live lease for exactly this triple means the backend already has it: skip the call.
  const stored = readStoredRegistration();
  if (stored?.key === key) {
    apply({ type: 'registered', key });
    return;
  }
  if (!shouldRegister(status, key)) return;

  apply({ type: 'registering' });
  try {
    await registerPushEndpoint({
      deviceId,
      userId: accountId,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      token,
    });
    writeStoredRegistration(key);
    apply({ type: 'registered', key });
    log.info('push registered with backend');
  } catch (err) {
    // Offline or a backend hiccup. Keep the token, stay unavailable, retry on the next init /
    // foreground — never spin here, that is what wakes a sleeping device.
    apply({ type: 'failed', error: String(err) });
    log.warn('push registration failed', { reason: String(err) });
  }
}

/**
 * Bring push up. Idempotent and safe on every launch, after login, and after a token rotation.
 * Never throws — a push failure must not take the app down with it.
 */
export function initPush(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const supported = await nativePush.isSupported();
      if (!supported) {
        // No native module, no `google-services.json`, or no Play Services. Expected on a fresh
        // clone and on iOS — the SyncEngine simply keeps its background socket.
        apply({ type: 'unsupported' });
        log.info(
          'push unsupported on this build/device — background socket retained',
        );
        return;
      }
      installListeners();
      // Drain BEFORE anything can fail below: a reply the user typed into a notification is
      // already owed to them, and it must not be held hostage by a revoked permission or a
      // registration that cannot complete offline.
      await drainPendingEvents();
      await refreshPermission();
      if (status.permission !== 'granted') {
        log.info(
          'push: notification permission not granted — push unavailable',
        );
        return;
      }
      await syncRegistration();
    } catch (err) {
      log.warn('push init failed', { reason: String(err) });
      apply({ type: 'failed', error: String(err) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Logout. Clears the token so the NEXT account on this device cannot inherit it, and best-effort
 * clears the server-side endpoint while the access token is still valid.
 *
 * MUST be called BEFORE `clearSession()` — the backend call needs the bearer token, and the body
 * needs the account/device ids.
 */
export async function unregisterPush(): Promise<void> {
  const accountId = getAccountId();
  const deviceId = getDeviceId();

  // 1. Tell the backend to stop targeting this device (best-effort; no DELETE endpoint exists).
  if (accountId && deviceId && status.phase !== 'unsupported') {
    try {
      await clearPushEndpoint(
        deviceId,
        accountId,
        Platform.OS === 'ios' ? 'ios' : 'android',
      );
    } catch (err) {
      log.info('push: endpoint clear failed (server row may be stale)', {
        reason: String(err),
      });
    }
  }

  // 2. Kill the token at the OS/FCM level. This is the part that actually guarantees the old
  //    account's pushes can never be delivered here, even if the server row survives.
  await nativePush.deleteToken();

  // 3. Drop anything that could leak into the next sign-in — including the native mirror of
  //    the ack credentials, the conversation names, and any queued action. Leaving those behind
  //    would let a push meant for the previous account be acknowledged by the next one.
  forgetStoredRegistration();
  await nativePush.clearSession();
  await nativePush.clearDisplayedNotifications();
  apply({ type: 'unregistered' });
  log.info('push unregistered');
}

/**
 * Release every subscription this module owns (§M7). Called from the App unmount effect; also
 * makes the module safe to re-init in tests.
 */
export function disposePush(): void {
  unsubToken?.();
  unsubMessage?.();
  unsubAppState?.();
  unsubPending?.();
  unsubToken = null;
  unsubMessage = null;
  unsubAppState = null;
  unsubPending = null;
  messageListeners.clear();
  availabilityListeners.clear();
  eventListeners.clear();
}

/** Test-only: reset module state between cases. */
export function __resetPushForTests(): void {
  disposePush();
  status = INITIAL_PUSH_STATUS;
  lastPublishedAvailability = null;
  inFlight = null;
  draining = null;
  forgetStoredRegistration();
}
