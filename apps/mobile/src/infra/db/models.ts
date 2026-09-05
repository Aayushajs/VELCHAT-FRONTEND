/**
 * WatermelonDB models (§L5). One class per table; the UI observes these. Conversation +
 * Message expose typed accessors for the fields the chat list/screen read; the remaining
 * tables (receipts, members, users, outbox, drafts, jobs) are registered with minimal
 * models for now and grow field accessors as their features land (MP2+).
 */
import { Model } from '@nozbe/watermelondb';
import { field, text } from '@nozbe/watermelondb/decorators';

export class Conversation extends Model {
  static override table = 'conversations';

  @text('type') type!: string;
  @text('name') name?: string;
  @text('avatar_media_id') avatarMediaId?: string;
  @text('peer_id') peerId?: string;
  @text('peer_avatar_url') peerAvatarUrl?: string;
  @field('peer_avatar_at') peerAvatarAt?: number;
  @field('is_announcement') isAnnouncement!: boolean;
  @field('is_pinned') isPinned!: boolean;
  @field('is_archived') isArchived!: boolean;
  @field('is_muted_until') isMutedUntil?: number;
  @field('is_locked') isLocked!: boolean;
  @text('last_message_preview') lastMessagePreview?: string;
  @field('last_message_seq') lastMessageSeq?: number;
  @field('last_message_at') lastMessageAt?: number;
  @field('unread_count') unreadCount!: number;
  @field('mention_count') mentionCount!: number;
  @text('notif_level') notifLevel!: string;
  @field('created_at') createdAt!: number;
  @field('updated_at') updatedAt!: number;
}

export class Message extends Model {
  static override table = 'messages';

  @text('client_msg_id') clientMsgId!: string;
  @text('conversation_id') conversationId!: string;
  @field('seq') seq?: number;
  @text('sender_id') senderId!: string;
  @text('type') type!: string;
  @text('content_plain') contentPlain?: string;
  @text('content_encrypted') contentEncrypted?: string;
  @text('reply_to_id') replyToId?: string;
  @text('reactions') reactions?: string;
  @text('attachments') attachments?: string;
  @text('state') state!: string;
  @field('deleted') deleted!: boolean;
  @field('view_once') viewOnce!: boolean;
  @field('starred') starred!: boolean;
  @field('created_at') createdAt!: number;
  @field('server_ts') serverTs?: number;
}

export class Receipt extends Model {
  static override table = 'receipts';
}

export class ConversationMember extends Model {
  static override table = 'conversation_members';
}

export class User extends Model {
  static override table = 'users';

  @text('account_id') accountId!: string;
  @text('display_name') displayName?: string;
  @text('avatar_media_id') avatarMediaId?: string;
}

export class Outbox extends Model {
  static override table = 'outbox';

  @text('kind') kind!: string;
  @text('conversation_id') conversationId?: string;
  @text('payload') payload!: string;
  @text('state') state!: string;
  @field('attempts') attempts!: number;
  @field('next_attempt_at') nextAttemptAt?: number;
  @text('last_error') lastError?: string;
  @field('created_at') createdAt!: number;
  @field('updated_at') updatedAt!: number;
}

export class Draft extends Model {
  static override table = 'drafts';

  @text('conversation_id') conversationId!: string;
  @text('text') text!: string;
}

export class UploadJob extends Model {
  static override table = 'upload_jobs';
}

export class DownloadJob extends Model {
  static override table = 'download_jobs';
}

export const modelClasses = [
  Conversation,
  Message,
  Receipt,
  ConversationMember,
  User,
  Outbox,
  Draft,
  UploadJob,
  DownloadJob,
];
