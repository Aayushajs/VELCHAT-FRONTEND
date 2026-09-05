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
import { log } from '../../core';
import { kv } from '../kv';
import { getAccountId, getDeviceId } from '../network';
import { hasNotificationPermission, subscribeAppState } from '../native';
import { clearPushEndpoint, registerPushEndpoint } from './api';
import { nativePush } from './nativePush';
import {
  INITIAL_PUSH_STATUS,
  isPushAvailable,
  reducePush,
  registrationKey,
  shouldRegister,
} from './pushState';
import type { PushEvent, PushMessage, PushStatus } from './types';

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

/** Owned subscriptions — every one of these is released by `disposePush()`. */
let unsubToken: (() => void) | null = null;
let unsubMessage: (() => void) | null = null;
let unsubAppState: (() => void) | null = null;

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
  if (!unsubAppState) {
    unsubAppState = subscribeAppState(state => {
      // Permission can be revoked from Settings while we sleep. Re-check on every foreground:
      // if it is gone, availability must drop so the SyncEngine stops trusting push.
      if (state !== 'active') return;
      void refreshPermission();
    });
  }
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

  // 3. Drop anything that could leak into the next sign-in.
  forgetStoredRegistration();
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
  unsubToken = null;
  unsubMessage = null;
  unsubAppState = null;
  messageListeners.clear();
  availabilityListeners.clear();
}

/** Test-only: reset module state between cases. */
export function __resetPushForTests(): void {
  disposePush();
  status = INITIAL_PUSH_STATUS;
  lastPublishedAvailability = null;
  inFlight = null;
  forgetStoredRegistration();
}
