/**
 * QA regression guard — composite indexes must exist on a FRESH install too (VC-024).
 *
 * WatermelonDB only runs the migration chain on an UPGRADE; a brand-new database takes the
 * `_setUpWithSchema` path, which emits DDL from `schema.ts` alone and never touches
 * `migrations.ts`. The v3 migration's composite indexes therefore only ever existed on installs
 * that upgraded through it — the inverse of what §M0's worst-device-first budget needs. The
 * schema's `unsafeSql` hook is WatermelonDB's supported way to inject extra DDL into that same
 * fresh-install path (`encodeSchema/index.js` calls it as `unsafeSql(sql, 'setup')`), so this
 * locks in that the hook actually appends every composite index, not just some.
 */
import { schema } from '../schema';
import { COMPOSITE_INDEXES } from '../compositeIndexes';

describe('VC-024 — a fresh install gets the same composite indexes as an upgrade', () => {
  it('the schema declares an unsafeSql hook (the fresh-install DDL path)', () => {
    expect(typeof schema.unsafeSql).toBe('function');
  });

  it('appends every composite index to the fresh-install ("setup") DDL', () => {
    const baseSql = 'create table "conversations" (...);';
    const result = schema.unsafeSql!(baseSql, 'setup');
    expect(result.startsWith(baseSql)).toBe(true);
    for (const index of COMPOSITE_INDEXES) {
      expect(result).toContain(index);
    }
  });

  it('leaves non-setup DDL (e.g. per-migration-step SQL) untouched', () => {
    const stepSql = 'alter table "messages" add "foo";';
    expect(schema.unsafeSql!(stepSql, 'create_indices')).toBe(stepSql);
  });
});
