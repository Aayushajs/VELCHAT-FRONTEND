/**
 * infra/network — Axios client + interceptors (§M7/§L3).
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export { queryClient } from './queryClient';
export { api, refreshAccessToken, refreshSession, warmBackend } from './client';
export {
  sendChatMessage,
  fetchMessagesAfter,
  fetchPeerReceipts,
  normalizeSendAck,
  normalizeServerMessage,
} from './chat';
export type { SendMessageInput, SendAck, ServerMessage } from './chat';
export {
  createDm,
  getConversationDetails,
  getConversationMembers,
  fetchInbox,
} from './conversations';
export type { InboxConversation } from './conversations';
export {
  getPresence,
  subscribePresence,
  presenceOnline,
  presenceOffline,
  presenceHeartbeat,
  PRESENCE_ONLINE_TTL_MS,
  normalizePresenceEvent,
} from './presence';
export type { PresenceResult, PresenceEvent } from './presence';
export type {
  CreateDmResult,
  ConversationDetails,
  ConversationType,
} from './conversationShape';
export { AppError, isAppError, normalizeError } from './errors';
export type { AppErrorKind } from './errors';
export {
  getOprfKey,
  oprfEvaluate,
  oprfRegister,
  oprfMatch,
  oprfRegisterEdges,
  OPRF_EVALUATE_BATCH_CAP,
  OPRF_MATCH_BATCH_CAP,
} from './discovery';
export type { OprfKeyResponse, OprfEvaluateResponse } from './discovery';
export {
  getAccessToken,
  getRefreshToken,
  getDeviceId,
  getAccountId,
  getPhone,
  hasSession,
  hasValidSession,
  accessTokenExpiresInMs,
  setTokens,
  clearSession,
  subscribeSession,
} from './tokens';
export type { SessionTokens } from './tokens';
