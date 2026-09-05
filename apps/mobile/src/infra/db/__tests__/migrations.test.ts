/**
 * The migration chain is a DATA-SAFETY contract (§L2/§M10).
 *
 * WatermelonDB resets a database whose version it cannot migrate — silently wiping the user's
 * entire local history on an app update. So every schema version must have a step, the steps must
 * be ordered, and the newest step must reach the schema's current version. A mismatch here is not
 * a failing test in the abstract; it is every existing install losing its chats on the next release.
 */
import { schema } from '../schema';
import { migrations } from '../migrations';

interface Step {
  toVersion: number;
}

function steps(): Step[] {
  return (migrations as unknown as { sortedMigrations: Step[] })
    .sortedMigrations;
}

describe('schema migrations', () => {
  it('can migrate an install up to the schema the app now ships', () => {
    const versions = steps().map(m => m.toVersion);
    expect(Math.max(...versions)).toBe(schema.version);
  });

  it('covers every version from the first release onward, with no hole', () => {
    // A missing intermediate version makes WatermelonDB give up and reset the database, so an
    // install that skipped a release is exactly the one that loses its data.
    const versions = steps()
      .map(m => m.toVersion)
      .sort((a, b) => a - b);
    for (let v = 2; v <= schema.version; v++) {
      expect(versions).toContain(v);
    }
  });

  it('declares each version exactly once', () => {
    const versions = steps().map(m => m.toVersion);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('indexes the chat list query, which is ordered as well as filtered', () => {
    // `WHERE is_archived AND last_message_at > 0 ORDER BY is_pinned DESC, last_message_at DESC`
    // cannot be satisfied by the separate single-column indexes: SQLite picks one, then sorts the
    // whole remaining set in memory on every emission — and this query re-runs on EVERY write to
    // the table.
    const sql = JSON.stringify(steps());
    expect(sql).toContain('conversations');
    expect(sql).toMatch(/is_archived.*is_pinned.*last_message_at/);
  });

  it('indexes the message window query the chat screen subscribes to', () => {
    const sql = JSON.stringify(steps());
    expect(sql).toMatch(/messages.*conversation_id.*created_at/);
  });
});
