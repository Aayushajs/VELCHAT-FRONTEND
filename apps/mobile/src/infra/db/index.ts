/**
 * infra/db — WatermelonDB adapter, schema + models (§L5). The local DB is the UI's
 * source of truth; features observe collections, the sync engine writes them.
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export { schema } from './schema';
export {
  observeConversations,
  listConversationIds,
  clearUnread,
  upsertConversation,
  peerIdentityAgeMs,
  peerIdFor,
  observeConversation,
  purgeAllLocalChat,
} from './queries';
export type { ConversationPatch, RowStream } from './queries';
export {
  observeMessages,
  sendMessageLocal,
  applyServerMessage,
  applyServerMessages,
  markMessageSent,
  markMessageFailed,
  markMessageSending,
  maxSeqForConversation,
  minSeqForConversation,
  countMessages,
  MESSAGE_PAGE,
  applyReceipt,
} from './messages';
export {
  enqueueSend,
  enqueueOptimisticSend,
  claimNextDue,
  markAckd,
  markFailed,
  recoverStuckSends,
  requeueFailed,
  outboxStats,
} from './outbox';
export type { OutboxItem, OutboxStats } from './outbox';
export { classifySendFailure } from './sendFailurePolicy';
export { shouldProbeGap } from './gapDetection';
export type { GapProbeInput } from './gapDetection';
export type { SendFailureDecision } from './sendFailurePolicy';
export {
  reconcileDecision,
  backoffMs,
  nextOutboxRetry,
  MAX_SEND_ATTEMPTS,
} from './syncLogic';
export type { ReconcileAction, BackoffOptions } from './syncLogic';
export {
  searchConversations,
  searchMessages,
  fetchConversationNames,
  sanitizeLikeQuery,
} from './search';
export type { ConversationSearchHit, MessageSearchHit } from './search';
export {
  pendingReceiptFrames,
  mergeWatermark,
  EMPTY_WATERMARKS,
} from './receiptLedger';
export type {
  ReceiptWatermarks,
  ReceiptState,
  ReceiptFrame,
} from './receiptLedger';
export {
  getDesired,
  getSent,
  noteDesired,
  noteSent,
  getPeerWatermark,
  notePeerWatermark,
  markDirty,
  takeDirty,
  hasDirty,
  clearAllReceipts,
} from './receiptStore';
export {
  Conversation,
  Message,
  Receipt,
  ConversationMember,
  User,
  Outbox,
  Draft,
  UploadJob,
  DownloadJob,
} from './models';
