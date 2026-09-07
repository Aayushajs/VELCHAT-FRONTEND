/**
 * The push lifecycle as a PURE reducer — no React Native, no I/O, no timers.
 *
 * Push has more edge cases than it looks: the OS rotates tokens whenever it feels like it, the
 * user can revoke notification permission from Settings while the app sleeps, and an account
 * switch must never leave the previous user's device registered. Keeping all of that in a pure
 * function means those paths are unit-tested (`__tests__/pushState.test.ts`) instead of
 * discovered in production at 3 a.m.
 *
 * The one rule everything else derives from (§M13): `isPushAvailable` is true ONLY when the
 * backend demonstrably holds our CURRENT token and the OS will let us show something. The
 * SyncEngine drops its background socket on the strength of that boolean, so an optimistic
 * `true` does not cost battery — it costs the user their messages.
 */
import type { PushEvent, PushStatus } from './types';

export const INITIAL_PUSH_STATUS: PushStatus = {
  phase: 'idle',
  token: null,
  permission: 'unavailable',
  registeredKey: null,
  error: null,
};

/**
 * The dedup key for one registration: which account, on which device, with which token.
 *
 * Each part is percent-encoded before joining so a value that itself contains the separator
 * cannot forge a different triple's key (`('a|d','x')` must not equal `('a','d|x')`) — that
 * would silently suppress a real re-registration.
 */
export function registrationKey(
  accountId: string,
  deviceId: string,
  token: string,
): string {
  return [accountId, deviceId, token].map(encodeURIComponent).join('|');
}

/** Fold one event into the status. Returns the SAME object when nothing changed. */
export function reducePush(s: PushStatus, e: PushEvent): PushStatus {
  switch (e.type) {
    case 'unsupported':
      // Terminal for this install+build: no native module, no Firebase config, or no Play
      // Services. Not an error — the app falls back to the background socket.
      if (s.phase === 'unsupported') return s;
      return {
        ...s,
        phase: 'unsupported',
        token: null,
        registeredKey: null,
        error: null,
      };

    case 'permission': {
      if (s.phase === 'unsupported') return s; // permission can't conjure a transport
      if (s.permission === e.permission) return s; // re-asserted on every foreground: no churn
      // Permission decides whether we may SHOW something, not whether we can be woken: FCM
      // delivers data messages regardless of POST_NOTIFICATIONS. The registration therefore
      // survives a denial untouched — dropping it would also kill the delivery receipt a woken
      // app sends, i.e. the sender's second tick, for a recipient who merely muted the OS.
      return { ...s, permission: e.permission };
    }

    case 'token': {
      if (s.phase === 'unsupported') return s;
      if (s.token === e.token) return s; // same token re-delivered — idempotent, no re-POST
      return {
        ...s,
        token: e.token,
        // A token we have not registered under is not a registration.
        registeredKey: null,
        phase: s.phase === 'denied' ? 'denied' : 'idle',
        error: null,
      };
    }

    case 'registering':
      if (s.phase === 'unsupported' || s.phase === 'denied') return s;
      return { ...s, phase: 'registering', error: null };

    case 'registered':
      if (s.phase === 'unsupported') return s;
      return { ...s, phase: 'registered', registeredKey: e.key, error: null };

    case 'failed':
      if (s.phase === 'unsupported') return s;
      // Keep the token — the failure was the backend call, not the OS. The next init retries.
      return { ...s, phase: 'failed', error: e.error };

    case 'unregistered':
      // Logout. The permission answer survives (logging out does not un-grant it); everything
      // that ties this device to an ACCOUNT does not.
      return {
        phase: s.phase === 'unsupported' ? 'unsupported' : 'idle',
        token: null,
        permission: s.permission,
        registeredKey: null,
        error: null,
      };
  }
}

/**
 * May the SyncEngine release its background socket? Only when a push can genuinely reach this
 * user: registered with the backend, holding that token, and allowed to display it.
 */
export function isPushAvailable(s: PushStatus): boolean {
  return (
    s.phase === 'registered' && s.token !== null && s.permission === 'granted'
  );
}

/**
 * Should we call `POST /notifications/endpoints` for `key` right now?
 *
 * This is the duplicate-registration guard: it says no on every cold start that has not changed
 * anything, and yes the moment the token rotates or the account changes.
 */
export function shouldRegister(s: PushStatus, key: string): boolean {
  if (s.phase === 'unsupported' || s.phase === 'registering') return false;
  // Deliberately NOT gated on permission. A device that cannot show a notification can still be
  // woken by a data message and still acknowledge delivery — and refusing to register it was
  // silently costing the sender their second tick whenever the recipient had notifications off.
  if (s.token === null) return false;
  return s.registeredKey !== key;
}
