/**
 * The WatermelonDB instance (§L2 boot step, §M10). One encrypted-at-rest SQLite DB is
 * the UI's source of truth. JSI adapter → reads run off the JS thread (§M0 "zero jank").
 *
 * Constructed LAZILY + guarded: `new SQLiteAdapter({ jsi:true })` throws SYNCHRONOUSLY if
 * the native module isn't in the binary yet (e.g. a not-yet-rebuilt binary / stale Metro
 * cache after adding WatermelonDB). Building it on first use (not at import) keeps that
 * failure contained to the chat features — the infra barrel is imported app-wide, so an
 * import-time throw would crash the WHOLE app. Callers `.catch` the rejection.
 */
import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { log } from '../../core';
import { schema } from './schema';
import { migrations } from './migrations';
import { modelClasses } from './models';

let db: Database | null = null;

export function getDatabase(): Database {
  if (db) return db;
  try {
    const adapter = new SQLiteAdapter({
      dbName: 'velchat',
      schema,
      // Without migrations a version bump silently RESETS the database — the user's whole local
      // history gone on an app update. Every schema change ships its step here.
      migrations,
      // New Architecture: JSI is available → off-thread, synchronous-fast reads.
      jsi: true,
      onSetUpError: error => {
        // A corrupt/incompatible DB → boot to a safe re-sync (§M0/§R); the MP2 sync
        // engine re-hydrates from the server. Logged (never silent).
        log.error('watermelondb setup error', { err: String(error) });
      },
    });
    db = new Database({ adapter, modelClasses });
    return db;
  } catch (e) {
    log.error(
      'watermelondb init failed — native module missing? a clean rebuild is needed',
      { err: String(e) },
    );
    throw e;
  }
}
