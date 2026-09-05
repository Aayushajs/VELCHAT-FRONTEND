/**
 * core/ — cross-feature: config, env, feature flags, logger, telemetry.
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export { appEnv } from './config/env';
export type { AppEnv, AppEnvName } from './config/env';
export { log, redact, scrubString } from './logger';
export type { LogContext } from './logger';
export {
  FeatureFlagsProvider,
  useFeatureFlag,
  useFeatureFlags,
  DEFAULT_FLAGS,
} from './feature-flags';
export type { FeatureFlags, FeatureFlagKey } from './feature-flags';
export { useConnectivity, isOffline, isFlightMode } from './connectivity';
export { useActiveTab } from './activeTab';
export type { TabName } from './activeTab';
export {
  useRealtimeStore,
  useTypingUser,
  usePresence,
  isTypingActive,
  normalizePresenceStatus,
  TYPING_TTL_MS,
} from './realtimeStore';
export type {
  ConnectionState,
  PresenceStatus,
  PresenceEntry,
  TypingEntry,
} from './realtimeStore';
export {
  recordLatency,
  timed,
  latencyStats,
  allLatencyStats,
  logLatencySnapshot,
  resetLatency,
} from './perf/latency';
export type { LatencySpan, LatencyStats } from './perf/latency';
