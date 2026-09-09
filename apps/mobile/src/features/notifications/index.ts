/**
 * features/notifications — notification preferences + the push runtime (§B10, ADR 0008).
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export { setConversationMute } from './api/prefs';
export { PushBlockerBanner } from './ui/PushBlockerBanner';
export { usePushBlocker } from './hooks/usePushBlocker';
export {
  startPushRuntime,
  stopPushRuntime,
  shutdownPushForSignOut,
  runQueuedPushActions,
} from './model/pushRuntime';
