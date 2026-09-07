/**
 * infra/push — FCM push transport + the notification-action queue (§M14/§L12, ADR 0008).
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 *
 * Note what is NOT exported: `nativePush`. Nothing above this layer may talk to the native
 * module directly — availability reaches the SyncEngine through `subscribePushAvailability`,
 * and notification actions through `subscribePushEvents`, precisely so that `domain/` never
 * grows an import back into `infra/`.
 */
export {
  initPush,
  unregisterPush,
  disposePush,
  getPushStatus,
  subscribePushAvailability,
  subscribePushMessages,
  subscribePushEvents,
  drainPendingEvents,
  syncConversationNames,
  setNativeMute,
  clearConversationNotification,
  __resetPushForTests,
} from './pushService';
export {
  parsePendingEvent,
  parsePendingEvents,
  collapsePendingEvents,
} from './pendingEvents';
export {
  INITIAL_PUSH_STATUS,
  isPushAvailable,
  reducePush,
  registrationKey,
  shouldRegister,
} from './pushState';
export type {
  PushEvent,
  PushMessage,
  PushPendingEvent,
  PushPermission,
  PushPhase,
  PushStatus,
  RegisterEndpointBody,
} from './types';
