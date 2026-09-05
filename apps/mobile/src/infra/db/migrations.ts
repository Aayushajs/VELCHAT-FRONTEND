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
  ],
});
