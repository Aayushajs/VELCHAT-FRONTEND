/**
 * features/chat — conversation list + (MP2) chat runtime. Shape: ui/ model/ api/ hooks/ db/.
 *
 * Public API barrel. Import this layer only through its index (`eslint-plugin-boundaries`).
 * Dependency rule (§M3): UI → Feature → Domain → Infra. Never the reverse.
 */
export { ChatsList } from './ui/ChatsList';
export { ChatScreen } from './ui/ChatScreen';
export { NewChatScreen } from './ui/NewChatScreen';
export { useConversations } from './hooks/useConversations';
export type { ConversationRowVM } from './hooks/useConversations';
export { clearConversationPeerCache } from './hooks/useConversationPeer';
export { useStartDm } from './hooks/useStartDm';
export { backfillInbox } from './api/backfillInbox';
