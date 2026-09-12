/**
 * The push lifecycle is a pure state machine so the nasty cases — permission revoked mid-run,
 * a token rotating under us, an account switch, a duplicate init — are testable without a
 * device. These tests encode the §M13 contract: `pushAvailable` is true ONLY when the backend
 * demonstrably holds our current token AND the OS will let us show something.
 */
import {
  INITIAL_PUSH_STATUS,
  reducePush,
  isPushAvailable,
  registrationKey,
  shouldRegister,
  notificationsGranted,
} from '../pushState';
import type { PushEvent, PushStatus } from '../types';

/** Drive the machine through a list of events, from the initial state. */
function run(...events: PushEvent[]): PushStatus {
  return events.reduce(reducePush, INITIAL_PUSH_STATUS);
}

const BASE = 'https://api.example.test';
const KEY = registrationKey('acc-1', 'dev-1', 'tok-1', BASE);

describe('registrationKey', () => {
  it('distinguishes account, device and token', () => {
    expect(registrationKey('a', 'd', 't', BASE)).not.toBe(
      registrationKey('b', 'd', 't', BASE),
    );
    expect(registrationKey('a', 'd', 't', BASE)).not.toBe(
      registrationKey('a', 'e', 't', BASE),
    );
    expect(registrationKey('a', 'd', 't', BASE)).not.toBe(
      registrationKey('a', 'd', 'u', BASE),
    );
  });

  it('is stable for the same triple', () => {
    expect(registrationKey('a', 'd', 't', BASE)).toBe(
      registrationKey('a', 'd', 't', BASE),
    );
  });

  it('cannot be collided by a value containing the separator', () => {
    // 'a|d' + 'x' must not collide with 'a' + 'd|x'.
    expect(registrationKey('a|d', 'x', 't', BASE)).not.toBe(
      registrationKey('a', 'd|x', 't', BASE),
    );
  });
});

describe('the happy path', () => {
  it('reaches registered and reports push as available', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registering' },
      { type: 'registered', key: KEY },
    );
    expect(s.phase).toBe('registered');
    expect(s.token).toBe('tok-1');
    expect(s.registeredKey).toBe(KEY);
    expect(isPushAvailable(s)).toBe(true);
  });
});

describe('push is NOT available until the backend actually holds the token', () => {
  it('is unavailable with a token but no successful registration', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
    );
    expect(isPushAvailable(s)).toBe(false);
  });

  it('is unavailable while a registration is in flight', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registering' },
    );
    expect(isPushAvailable(s)).toBe(false);
  });

  it('is unavailable when the backend refused', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registering' },
      { type: 'failed', error: 'http 500' },
    );
    expect(s.phase).toBe('failed');
    expect(isPushAvailable(s)).toBe(false);
  });

  it('is unavailable on a build with no push transport at all', () => {
    const s = run({ type: 'unsupported' });
    expect(s.phase).toBe('unsupported');
    expect(isPushAvailable(s)).toBe(false);
  });
});

describe('permission', () => {
  it('denial stops push being AVAILABLE but keeps the registration', () => {
    // Permission decides whether we may SHOW something, not whether we can be woken: FCM
    // delivers data messages regardless of POST_NOTIFICATIONS. Dropping the registration here
    // also killed the delivery receipt a woken app sends — so a recipient who merely switched
    // notifications off left every sender on one grey tick, permanently.
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registered', key: KEY },
      { type: 'permission', permission: 'denied' },
    );
    expect(isPushAvailable(s)).toBe(false); // the SyncEngine must keep its socket
    expect(s.registeredKey).toBe(KEY); // …but the device stays wakeable
    expect(s.token).toBe('tok-1');
  });

  it('re-granting permission restores availability with no re-registration', () => {
    // The token never went away, so there is nothing to re-POST. Forcing a round trip here was
    // pure churn on a path that runs on every foreground.
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registered', key: KEY },
      { type: 'permission', permission: 'denied' },
      { type: 'permission', permission: 'granted' },
    );
    expect(isPushAvailable(s)).toBe(true);
    expect(s.registeredKey).toBe(KEY);
    expect(shouldRegister(s, KEY)).toBe(false);
  });

  it('permission events never resurrect an unsupported build', () => {
    const s = run(
      { type: 'unsupported' },
      { type: 'permission', permission: 'granted' },
    );
    expect(s.phase).toBe('unsupported');
    expect(shouldRegister(s, KEY)).toBe(false);
  });
});

describe('token rotation', () => {
  it('a NEW token invalidates the registration so it is re-sent', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registered', key: KEY },
      { type: 'token', token: 'tok-2' },
    );
    expect(s.token).toBe('tok-2');
    expect(s.registeredKey).toBeNull();
    expect(s.phase).toBe('idle');
    expect(isPushAvailable(s)).toBe(false);
  });

  it('the SAME token re-delivered changes nothing (idempotent — no re-POST storm)', () => {
    const registered = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registered', key: KEY },
    );
    const again = reducePush(registered, { type: 'token', token: 'tok-1' });
    expect(again).toBe(registered); // referentially identical: no churn, no listener storm
    expect(isPushAvailable(again)).toBe(true);
  });

  it('losing the token drops availability', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registered', key: KEY },
      { type: 'token', token: null },
    );
    expect(s.token).toBeNull();
    expect(s.registeredKey).toBeNull();
    expect(isPushAvailable(s)).toBe(false);
  });
});

describe('shouldRegister — the duplicate-registration guard', () => {
  const registered = run(
    { type: 'permission', permission: 'granted' },
    { type: 'token', token: 'tok-1' },
    { type: 'registered', key: KEY },
  );

  it('is false when the backend already holds exactly this triple', () => {
    expect(shouldRegister(registered, KEY)).toBe(false);
  });

  it('is true when the account changed under the same token (logout → new login)', () => {
    const otherAccount = registrationKey('acc-2', 'dev-1', 'tok-1', BASE);
    expect(shouldRegister(registered, otherAccount)).toBe(true);
  });

  it('is TRUE without permission, for a device that has never registered', () => {
    // A device that cannot display a notification can still be woken and can still acknowledge
    // delivery. Refusing to register it is what silently cost the sender their second tick.
    const denied = run(
      { type: 'permission', permission: 'denied' },
      { type: 'token', token: 'tok-1' },
    );
    expect(shouldRegister(denied, KEY)).toBe(true);
  });

  it('treats a DIFFERENT BACKEND as a different registration', () => {
    // A device that switches environments must re-register. Without the base URL in the key, the
    // lease says "already registered", the POST is skipped, and push is dead with no error —
    // the same silent-mislabel class of failure that shipped an APK pointing at the wrong server.
    const other = registrationKey(
      'acc-1',
      'dev-1',
      'tok-1',
      'https://other.example.test',
    );
    expect(other).not.toBe(KEY);
    expect(shouldRegister(registered, other)).toBe(true);
  });

  it('is false without a token', () => {
    const noToken = run({ type: 'permission', permission: 'granted' });
    expect(shouldRegister(noToken, KEY)).toBe(false);
  });

  it('is false while one is already in flight (no double POST)', () => {
    const inFlight = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registering' },
    );
    expect(shouldRegister(inFlight, KEY)).toBe(false);
  });

  it('is true after a failure, so the next init retries', () => {
    const failed = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registering' },
      { type: 'failed', error: 'offline' },
    );
    expect(shouldRegister(failed, KEY)).toBe(true);
  });
});

describe('logout', () => {
  const afterLogout = run(
    { type: 'permission', permission: 'granted' },
    { type: 'token', token: 'tok-1' },
    { type: 'registered', key: KEY },
    { type: 'unregistered' },
  );

  it('clears the token and the registration so the next account cannot inherit them', () => {
    expect(afterLogout.token).toBeNull();
    expect(afterLogout.registeredKey).toBeNull();
    expect(afterLogout.phase).toBe('idle');
    expect(isPushAvailable(afterLogout)).toBe(false);
  });

  it('keeps the OS permission answer — logging out does not un-grant it', () => {
    expect(afterLogout.permission).toBe('granted');
  });

  it('leaves an unsupported build unsupported', () => {
    const s = run({ type: 'unsupported' }, { type: 'unregistered' });
    expect(s.phase).toBe('unsupported');
  });
});

describe('failure diagnostics never carry the token', () => {
  it('keeps the error string separate from the token', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'super-secret-token' },
      { type: 'failed', error: 'http 401' },
    );
    expect(s.error).toBe('http 401');
    expect(s.error).not.toContain('super-secret-token');
  });
});

describe('notificationsGranted (VC-012)', () => {
  // On Android <33 there is no runtime permission dialog, so `permitted` (the raw dialog
  // answer) is unconditionally true — it says nothing about whether the user switched the
  // app's notifications off in system Settings, or the message channel is blocked. Only the
  // native `areNotificationsEnabled`-backed check (`blocked`) can see that on every API level,
  // and the two questions must BOTH clear before `isPushAvailable` may drop the socket.
  it('requires the permission AND the OS not blocking the channel/app', () => {
    expect(notificationsGranted(true, false)).toBe(true);
  });

  it('the exact defect: permitted=true (pre-33 hardcode) but the OS is blocking it', () => {
    expect(notificationsGranted(true, true)).toBe(false);
  });

  it('denied permission is never granted, even if somehow not reported blocked', () => {
    expect(notificationsGranted(false, false)).toBe(false);
  });

  it('both against us stays denied', () => {
    expect(notificationsGranted(false, true)).toBe(false);
  });
});
