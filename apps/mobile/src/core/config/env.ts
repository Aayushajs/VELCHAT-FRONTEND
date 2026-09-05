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

const rawName = Config.ENV;
const name: AppEnvName =
  rawName === 'stage' || rawName === 'prod' ? rawName : 'dev';

export const appEnv: AppEnv = {
  name,
  // Fallbacks are only hit in Jest (native module absent) or a misbuilt binary.
  // Real values come from the flavor's `.env.<flavor>` at build time.
  // Clients only ever talk to the EDGE GATEWAY — one base URL per environment, never a
  // per-service host (D:\Velchat\docs\RUNBOOK.md §0b). Production is the safe fallback.
  apiBaseUrl: Config.API_BASE_URL ?? 'https://velchat.duckdns.org',
  wsUrl: Config.WS_URL ?? 'wss://velchat.duckdns.org/ws',
};
