/**
 * What the connection strip should say (§M21/§21 of the product mandate).
 *
 * The app already tracks a rich realtime state — connecting, syncing, live, reconnecting — and
 * NOTHING rendered it. The only indicator was the OS network flag, so the case that actually
 * confuses people was invisible: full signal, WiFi connected, but the socket is down after a
 * server restart or a token expiry. The app looks perfectly online while messages silently stop
 * arriving, and the user is left asking whether their message sent.
 *
 * The opposite failure matters just as much: flashing "Connecting…" for the few hundred
 * milliseconds every cold start spends opening a socket would be noise, and noise trains people
 * to ignore the strip. So a degraded realtime link is only announced once it has persisted.
 */
import { connectionBanner } from '../connectionBanner';

const GRACE = 2000;

describe('connectionBanner', () => {
  it('says nothing when everything is working', () => {
    expect(
      connectionBanner({
        flightMode: false,
        online: true,
        realtime: 'live',
        degradedForMs: 0,
      }),
    ).toBeNull();
  });

  it('reports flight mode before anything else — it is the user is own doing', () => {
    expect(
      connectionBanner({
        flightMode: true,
        online: false,
        realtime: 'disconnected',
        degradedForMs: 99_999,
      }),
    ).toBe('flightMode');
  });

  it('reports a real network drop over a socket symptom of it', () => {
    // "You're offline" is the cause; "connecting" would be describing the consequence.
    expect(
      connectionBanner({
        flightMode: false,
        online: false,
        realtime: 'reconnecting',
        degradedForMs: 99_999,
      }),
    ).toBe('offline');
  });

  it('stays silent through the ordinary startup connect', () => {
    // Every cold start passes through `connecting`. Announcing it would put a banner on a
    // perfectly healthy launch.
    expect(
      connectionBanner({
        flightMode: false,
        online: true,
        realtime: 'connecting',
        degradedForMs: 800,
      }),
    ).toBeNull();
  });

  it('speaks up once the link has been down long enough to matter', () => {
    expect(
      connectionBanner({
        flightMode: false,
        online: true,
        realtime: 'connecting',
        degradedForMs: GRACE + 1,
      }),
    ).toBe('connecting');
  });

  it('distinguishes catching-up from being disconnected', () => {
    // The user is connected and their history is filling in — that is progress, not a fault.
    expect(
      connectionBanner({
        flightMode: false,
        online: true,
        realtime: 'syncing',
        degradedForMs: GRACE + 1,
      }),
    ).toBe('syncing');
  });

  it('treats a dropped socket on a live network as needing to be said', () => {
    expect(
      connectionBanner({
        flightMode: false,
        online: true,
        realtime: 'disconnected',
        degradedForMs: GRACE + 1,
      }),
    ).toBe('connecting');
  });

  it('goes quiet the moment the link is healthy again, with no lingering banner', () => {
    expect(
      connectionBanner({
        flightMode: false,
        online: true,
        realtime: 'live',
        degradedForMs: 99_999,
      }),
    ).toBeNull();
  });
});
