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
} from '../pushState';
import type { PushEvent, PushStatus } from '../types';

/** Drive the machine through a list of events, from the initial state. */
function run(...events: PushEvent[]): PushStatus {
  return events.reduce(reducePush, INITIAL_PUSH_STATUS);
}

const KEY = registrationKey('acc-1', 'dev-1', 'tok-1');

describe('registrationKey', () => {
  it('distinguishes account, device and token', () => {
    expect(registrationKey('a', 'd', 't')).not.toBe(
      registrationKey('b', 'd', 't'),
    );
    expect(registrationKey('a', 'd', 't')).not.toBe(
      registrationKey('a', 'e', 't'),
    );
    expect(registrationKey('a', 'd', 't')).not.toBe(
      registrationKey('a', 'd', 'u'),
    );
  });

  it('is stable for the same triple', () => {
    expect(registrationKey('a', 'd', 't')).toBe(registrationKey('a', 'd', 't'));
  });

  it('cannot be collided by a value containing the separator', () => {
    // 'a|d' + 'x' must not collide with 'a' + 'd|x'.
    expect(registrationKey('a|d', 'x', 't')).not.toBe(
      registrationKey('a', 'd|x', 't'),
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
  it('denial takes an already-registered device back to unavailable', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registered', key: KEY },
      { type: 'permission', permission: 'denied' },
    );
    expect(s.phase).toBe('denied');
    expect(isPushAvailable(s)).toBe(false);
  });

  it('re-granting permission re-registers rather than assuming the old one still stands', () => {
    const s = run(
      { type: 'permission', permission: 'granted' },
      { type: 'token', token: 'tok-1' },
      { type: 'registered', key: KEY },
      { type: 'permission', permission: 'denied' },
      { type: 'permission', permission: 'granted' },
    );
    expect(s.phase).toBe('idle');
    expect(s.registeredKey).toBeNull();
    expect(shouldRegister(s, KEY)).toBe(true);
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
    const otherAccount = registrationKey('acc-2', 'dev-1', 'tok-1');
    expect(shouldRegister(registered, otherAccount)).toBe(true);
  });

  it('is false without permission', () => {
    const denied = reducePush(registered, {
      type: 'permission',
      permission: 'denied',
    });
    expect(shouldRegister(denied, KEY)).toBe(false);
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
