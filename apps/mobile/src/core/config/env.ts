/**
 * Typed build-time environment config (§M4 core layer).
 *
 * Values are injected by react-native-config from the active flavor's
 * `.env.<flavor>` file at build time (dev / stage / prod). Fallbacks keep the
 * app functional in Jest (where the native module is absent) and as a safety net.
 */
import Config from 'react-native-config';

export type AppEnvName = 'dev' | 'stage' | 'prod';

export interface AppEnv {
  readonly name: AppEnvName;
  /** REST base URL (dev gateway). Android emulator -> host is 10.0.2.2. */
  readonly apiBaseUrl: string;
  /** WebSocket URL (realtime gateway via dev aggregator). */
  readonly wsUrl: string;
}

/**
 * Resolve the three raw `react-native-config` values into an `AppEnv` — pulled out as a pure
 * function so the fallback logic is unit-testable without fighting Jest's static module mock.
 *
 * VC-035: `name` and `apiBaseUrl` used to fall back INDEPENDENTLY — `name` defaulted to `'dev'`
 * while `apiBaseUrl` defaulted to the PRODUCTION host. A misbuilt binary (`Config` came back
 * empty — a stale bundle, an IDE sync, a debug APK where react-native-config's native module
 * never linked) then reported itself as the safe-sounding `'dev'` while every request — OTP
 * sends, phone numbers, tokens — actually went to production, undetected, from a debuggable APK.
 * The two must never be able to disagree: an unrecognised or missing `rawName` now falls back to
 * `'prod'` ALONGSIDE the URL fallback, so the diagnostic log line that prints `name` never lies
 * about which backend a broken build is actually talking to.
 */
export function resolveAppEnv(
  rawName: string | undefined,
  rawApiBaseUrl: string | undefined,
  rawWsUrl: string | undefined,
): AppEnv {
  const name: AppEnvName =
    rawName === 'dev' || rawName === 'stage' || rawName === 'prod'
      ? rawName
      : 'prod'; // unrecognised/missing Config -> assume the same safe fallback the URLs use
  return {
    name,
    // Real values come from the flavor's `.env.<flavor>` at build time. Clients only ever talk
    // to the EDGE GATEWAY — one base URL per environment, never a per-service host
    // (D:\Velchat\docs\RUNBOOK.md §0b). Production is the safe fallback.
    apiBaseUrl: rawApiBaseUrl ?? 'https://velchat.duckdns.org',
    wsUrl: rawWsUrl ?? 'wss://velchat.duckdns.org/ws',
  };
}

export const appEnv: AppEnv = resolveAppEnv(
  Config.ENV,
  Config.API_BASE_URL,
  Config.WS_URL,
);
