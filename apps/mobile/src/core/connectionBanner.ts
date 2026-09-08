/**
 * What the connection strip should say (§M21) — pure decision, no React, no I/O.
 *
 * The app tracks a rich realtime state (connecting → connected → syncing → live, plus
 * reconnecting) and, until now, rendered none of it: the strip only knew the OS network flag.
 * That left the genuinely confusing case invisible — full signal, WiFi fine, but the socket is
 * down after a server restart or an expired token. The app looks online while messages quietly
 * stop arriving, which is precisely the state a user cannot diagnose and shouldn't have to.
 *
 * The restraint matters as much as the reporting. Every cold start passes through `connecting`,
 * and a banner that flashes on a healthy launch is noise — and noise teaches people to ignore the
 * strip on the day it means something. So a degraded link is announced only once it has persisted
 * past the grace window.
 */
import type { ConnectionState } from './realtimeStore';

export type BannerKind = 'flightMode' | 'offline' | 'connecting' | 'syncing';

export interface BannerInput {
  flightMode: boolean;
  /** OS-level reachability. */
  online: boolean;
  realtime: ConnectionState;
  /** How long realtime has been anything other than healthy. */
  degradedForMs: number;
}

/** A realtime link that has nothing useful to report while it lasts. */
const HEALTHY: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  'live',
  'connected',
]);

/**
 * How long a degraded realtime link must persist before the user is told. Long enough that an
 * ordinary reconnect passes unremarked, short enough that a genuinely stuck link is not a mystery.
 */
export const BANNER_GRACE_MS = 2000;

export function connectionBanner(input: BannerInput): BannerKind | null {
  // The user turned it off themselves — say that, not what it caused.
  if (input.flightMode) return 'flightMode';
  // A real network drop is the CAUSE; the socket state is just its symptom. Reporting
  // "connecting" here would describe the consequence and hide the reason.
  if (!input.online) return 'offline';
  if (HEALTHY.has(input.realtime)) return null;
  if (input.degradedForMs <= BANNER_GRACE_MS) return null;
  // Connected and catching up is progress, not a fault — worth distinguishing, because
  // "syncing" tells the user their history is on its way rather than that something is wrong.
  return input.realtime === 'syncing' ? 'syncing' : 'connecting';
}
