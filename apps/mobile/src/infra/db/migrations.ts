/**
 * Schema migrations (§L2/§M10).
 *
 * WatermelonDB needs an explicit migration for every version bump. Without one it treats the
 * on-disk database as incompatible and RESETS it — silently wiping the user's local chat history
 * on an app update. That makes this file part of the data-safety contract, not boilerplate: a
 * schema change without a matching step here is data loss on every existing install.
 */
import {
  schemaMigrations,
  addColumns,
  unsafeExecuteSql,
} from '@nozbe/watermelondb/Schema/migrations';

export const migrations = schemaMigrations({
  migrations: [
    {
      // v1 → v2: denormalise a DM's peer identity onto the conversation row so the chat list
      // renders name + photo from local storage instead of three REST calls per row.
      toVersion: 2,
      steps: [
        addColumns({
          table: 'conversations',
          columns: [
            { name: 'peer_id', type: 'string', isOptional: true },
            { name: 'peer_avatar_url', type: 'string', isOptional: true },
            { name: 'peer_avatar_at', type: 'number', isOptional: true },
          ],
        }),
      ],
    },
    {
      /**
       * v2 → v3: composite indexes for the queries that actually run hot.
       *
       * Every index below exists because a specific query FILTERS on one column and ORDERS or
       * ranges on another. Single-column indexes cannot serve those: SQLite picks one, then sorts
       * or scans the rest in memory. That is affordable once — but these are subscription queries
       * that WatermelonDB re-runs on EVERY write to their table, synchronously on the JS thread
       * (jsi), so the cost lands directly on frame time while messages are arriving.
       *
       * `unsafeExecuteSql` is the only way to add an index to an EXISTING table: WatermelonDB's
       * `isIndexed` flag is applied at table-creation time and does nothing on migration. Each
       * statement is `IF NOT EXISTS`, so re-running a migration is harmless.
       */
      toVersion: 3,
      steps: [
        // Chat list: WHERE is_archived AND last_message_at > 0 ORDER BY is_pinned DESC,
        // last_message_at DESC. Column order mirrors the query — equality, then sort keys.
        unsafeExecuteSql(
          'CREATE INDEX IF NOT EXISTS conversations_list_idx ' +
            'ON conversations (is_archived, is_pinned, last_message_at);',
        ),
        // Chat window: WHERE conversation_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT n.
        // Without this, opening a long conversation scans that chat's whole history and sorts it
        // in memory before taking fifty rows.
        unsafeExecuteSql(
          'CREATE INDEX IF NOT EXISTS messages_window_idx ' +
            'ON messages (conversation_id, deleted, created_at);',
        ),
        // Inbound dedup: WHERE conversation_id IN (…) AND seq IN (…), run for every applied batch.
        unsafeExecuteSql(
          'CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ' +
            'ON messages (conversation_id, seq);',
        ),
        // Receipts: WHERE conversation_id = ? AND sender_id = ? AND seq <= ?. `sender_id` was not
        // indexed at all, so every receipt frame scanned the conversation.
        unsafeExecuteSql(
          'CREATE INDEX IF NOT EXISTS messages_receipt_idx ' +
            'ON messages (conversation_id, sender_id, seq);',
        ),
        // Outbox claim: WHERE state IN (queued, sending), ordered by when it is next due.
        unsafeExecuteSql(
          'CREATE INDEX IF NOT EXISTS outbox_due_idx ' +
            'ON outbox (state, next_attempt_at);',
        ),
      ],
    },
  ],
});
