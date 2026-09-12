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
import { COMPOSITE_INDEXES } from './compositeIndexes';

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
       *
       * These are the SAME statements `schema.ts`'s `unsafeSql` hook applies on a fresh install
       * (VC-024) — shared from `compositeIndexes.ts` so an upgraded install and a new one can
       * never end up with a different index set.
       */
      toVersion: 3,
      steps: COMPOSITE_INDEXES.map(unsafeExecuteSql),
    },
  ],
});
