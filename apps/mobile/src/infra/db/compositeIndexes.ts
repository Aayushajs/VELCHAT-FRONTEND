/**
 * Composite indexes (§L5) shared by the schema (fresh installs) and migration v3 (upgrades).
 *
 * WatermelonDB's per-column `isIndexed` cannot serve a query that filters on one column and
 * sorts/ranges on another — SQLite picks one index, then sorts or scans the rest in memory.
 * These back the subscription queries that re-run on EVERY write to their table (VC-024: kept
 * in one place so a fresh install and an upgrade can never end up with a different index set).
 */

// Chat list: WHERE is_archived AND last_message_at > 0 ORDER BY is_pinned DESC,
// last_message_at DESC. Column order mirrors the query — equality, then sort keys.
const CONVERSATIONS_LIST =
  'CREATE INDEX IF NOT EXISTS conversations_list_idx ' +
  'ON conversations (is_archived, is_pinned, last_message_at);';

// Chat window: WHERE conversation_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT n.
// Without this, opening a long conversation scans that chat's whole history and sorts it in
// memory before taking fifty rows.
const MESSAGES_WINDOW =
  'CREATE INDEX IF NOT EXISTS messages_window_idx ' +
  'ON messages (conversation_id, deleted, created_at);';

// Inbound dedup: WHERE conversation_id IN (…) AND seq IN (…), run for every applied batch.
const MESSAGES_CONV_SEQ =
  'CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ' +
  'ON messages (conversation_id, seq);';

// Receipts: WHERE conversation_id = ? AND sender_id = ? AND seq <= ?. `sender_id` was not
// indexed at all, so every receipt frame scanned the conversation.
const MESSAGES_RECEIPT =
  'CREATE INDEX IF NOT EXISTS messages_receipt_idx ' +
  'ON messages (conversation_id, sender_id, seq);';

// Outbox claim: WHERE state IN (queued, sending), ordered by when it is next due.
const OUTBOX_DUE =
  'CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (state, next_attempt_at);';

export const COMPOSITE_INDEXES: readonly string[] = [
  CONVERSATIONS_LIST,
  MESSAGES_WINDOW,
  MESSAGES_CONV_SEQ,
  MESSAGES_RECEIPT,
  OUTBOX_DUE,
];
