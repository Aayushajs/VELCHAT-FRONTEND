/**
 * WatermelonDB schema (§L5, §M10) — the LOCAL DB is the UI source of truth (§M0). The
 * network mutates the DB; the UI observes it. This is migration v1: the MP2 core tables
 * (conversations, messages, receipts, members, users, outbox, drafts, upload/download
 * jobs). WatermelonDB adds `id` + sync bookkeeping columns automatically.
 *
 * Every table is indexed for the queries it serves (§L5). JSON-shaped fields (mentions,
 * reactions, attachments, …) are stored as strings and parsed at the model boundary.
 */
import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 3,
  tables: [
    tableSchema({
      name: 'conversations',
      columns: [
        { name: 'type', type: 'string' }, // dm|group|channel|broadcast|community
        { name: 'tenant_id', type: 'string', isOptional: true },
        { name: 'name', type: 'string', isOptional: true },
        { name: 'avatar_media_id', type: 'string', isOptional: true },
        // Denormalised peer identity for DMs (schema v2). The inbox response already carries the
        // member ids, so the peer is known at sync time for free — storing it here is what lets a
        // chat-list row render with a name and a photo from a pure LOCAL read. Resolving it per
        // row instead cost three REST calls per row, per recycle, which on a real connection meant
        // photos that arrived late, out of order, or never.
        { name: 'peer_id', type: 'string', isOptional: true },
        { name: 'peer_avatar_url', type: 'string', isOptional: true },
        // When the photo was last resolved — drives revalidation, so a peer changing their picture
        // is picked up instead of a cached URL being trusted forever.
        { name: 'peer_avatar_at', type: 'number', isOptional: true },
        { name: 'is_announcement', type: 'boolean' },
        { name: 'is_pinned', type: 'boolean', isIndexed: true },
        { name: 'is_archived', type: 'boolean', isIndexed: true },
        { name: 'is_muted_until', type: 'number', isOptional: true },
        { name: 'is_locked', type: 'boolean' },
        { name: 'last_message_id', type: 'string', isOptional: true },
        { name: 'last_message_seq', type: 'number', isOptional: true },
        { name: 'last_message_preview', type: 'string', isOptional: true },
        {
          name: 'last_message_at',
          type: 'number',
          isOptional: true,
          isIndexed: true,
        },
        { name: 'unread_count', type: 'number' },
        { name: 'mention_count', type: 'number' },
        { name: 'notif_level', type: 'string' }, // all|mentions|none
        { name: 'wallpaper', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
        { name: 'server_updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'messages',
      columns: [
        { name: 'client_msg_id', type: 'string', isIndexed: true },
        { name: 'conversation_id', type: 'string', isIndexed: true },
        { name: 'seq', type: 'number', isOptional: true, isIndexed: true },
        { name: 'sender_id', type: 'string' },
        { name: 'type', type: 'string' }, // text|image|video|audio|voice|doc|…|system
        { name: 'content_encrypted', type: 'string', isOptional: true }, // base64 (E2EE, opaque)
        { name: 'content_plain', type: 'string', isOptional: true }, // enterprise (server-readable)
        { name: 'reply_to_id', type: 'string', isOptional: true },
        { name: 'thread_root_id', type: 'string', isOptional: true },
        { name: 'mentions', type: 'string', isOptional: true }, // JSON
        { name: 'reactions', type: 'string', isOptional: true }, // JSON
        { name: 'attachments', type: 'string', isOptional: true }, // JSON
        { name: 'state', type: 'string', isIndexed: true }, // sending|sent|delivered|read|failed|deleted
        { name: 'ephemeral_ttl', type: 'number', isOptional: true },
        { name: 'edited_at', type: 'number', isOptional: true },
        { name: 'edit_history', type: 'string', isOptional: true }, // JSON
        { name: 'deleted', type: 'boolean' },
        { name: 'deleted_scope', type: 'string', isOptional: true }, // me|everyone
        { name: 'view_once', type: 'boolean' },
        { name: 'starred', type: 'boolean' },
        { name: 'created_at', type: 'number', isIndexed: true },
        { name: 'server_ts', type: 'number', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'receipts',
      columns: [
        { name: 'conversation_id', type: 'string', isIndexed: true },
        { name: 'message_seq', type: 'number' },
        { name: 'user_id', type: 'string' },
        { name: 'state', type: 'string' }, // delivered|read
        { name: 'ts', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'conversation_members',
      columns: [
        { name: 'conversation_id', type: 'string', isIndexed: true },
        { name: 'user_id', type: 'string' },
        { name: 'role', type: 'string' },
        { name: 'notif_level', type: 'string' },
        { name: 'last_read_seq', type: 'number' },
        { name: 'joined_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'users',
      columns: [
        { name: 'account_id', type: 'string', isIndexed: true },
        { name: 'display_name', type: 'string', isOptional: true },
        { name: 'avatar_media_id', type: 'string', isOptional: true },
        { name: 'about', type: 'string', isOptional: true },
        { name: 'presence_hint', type: 'string', isOptional: true },
        { name: 'last_seen_hint', type: 'number', isOptional: true },
        { name: 'is_contact', type: 'boolean' },
        { name: 'is_blocked', type: 'boolean' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'outbox',
      columns: [
        { name: 'kind', type: 'string' }, // message.send|message.edit|…|media.upload
        { name: 'conversation_id', type: 'string', isOptional: true },
        { name: 'payload', type: 'string' }, // JSON
        { name: 'state', type: 'string', isIndexed: true }, // queued|sending|ackd|failed
        { name: 'attempts', type: 'number' },
        {
          name: 'next_attempt_at',
          type: 'number',
          isOptional: true,
          isIndexed: true,
        },
        { name: 'last_error', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'drafts',
      columns: [
        { name: 'conversation_id', type: 'string', isIndexed: true },
        { name: 'text', type: 'string' },
        { name: 'reply_to_id', type: 'string', isOptional: true },
        { name: 'attachments', type: 'string', isOptional: true }, // JSON
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'upload_jobs',
      columns: [
        { name: 'media_id', type: 'string', isIndexed: true },
        { name: 'path', type: 'string' },
        { name: 'size_bytes', type: 'number' },
        { name: 'uploaded_bytes', type: 'number' },
        { name: 'multipart_id', type: 'string', isOptional: true },
        { name: 'parts', type: 'string', isOptional: true }, // JSON
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'priority', type: 'number', isIndexed: true },
        { name: 'created_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'download_jobs',
      columns: [
        { name: 'media_id', type: 'string', isIndexed: true },
        { name: 'url', type: 'string' },
        { name: 'target_path', type: 'string' },
        { name: 'downloaded_bytes', type: 'number' },
        { name: 'total_bytes', type: 'number', isOptional: true },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'priority', type: 'number', isIndexed: true },
        { name: 'created_at', type: 'number' },
      ],
    }),
  ],
});
