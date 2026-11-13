/*
 * #465 the time in column: migration 16 creates `work_board_columns`, and the SQLite history keeps each
 * issue's column and since when, restarting the time only when the column changes.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { MIGRATIONS } from '../../src/adapters/sqlite/migrations.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { SqliteWorkColumnHistory } from '../../src/github/work-board-history.ts';

const T1 = '2026-11-13T10:00:00.000Z';
const T2 = '2026-11-13T11:00:00.000Z';
const T3 = '2026-11-13T12:00:00.000Z';

const history = () => new SqliteWorkColumnHistory(openSqliteStorage({ path: ':memory:' }).db);

describe('#465 work_board_columns', () => {
  test('migration 16 adds the table with the item key, the column and since when', () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 16));
    const storage = openSqliteStorage({ path: ':memory:' });
    const cols = (storage.db.prepare('PRAGMA table_info(work_board_columns)').all() as { name: string; pk: number; notnull: number }[]).map((c) => [c.name, c.pk, c.notnull]);
    assert.deepEqual(cols, [['item_key', 1, 1], ['column_id', 0, 1], ['since', 0, 1]]);
    storage.close();
  });

  test('the first observation records its `at`', async () => {
    const h = history();
    const since = await h.observe([{ key: 'acme/app#1', column: 'planning', at: T1 }]);
    assert.deepEqual([...since], [['acme/app#1', T1]]);
  });

  test('the same column keeps its since', async () => {
    const h = history();
    await h.observe([{ key: 'acme/app#1', column: 'planning', at: T1 }]);
    const since = await h.observe([{ key: 'acme/app#1', column: 'planning', at: T2 }]);
    assert.equal(since.get('acme/app#1'), T1);
  });

  test('a different column restarts at the new `at`, and keeps it from then on', async () => {
    const h = history();
    await h.observe([{ key: 'acme/app#1', column: 'planning', at: T1 }]);
    assert.equal((await h.observe([{ key: 'acme/app#1', column: 'running', at: T2 }])).get('acme/app#1'), T2);
    assert.equal((await h.observe([{ key: 'acme/app#1', column: 'running', at: T3 }])).get('acme/app#1'), T2);
  });

  test('keys not observed are left untouched and not returned', async () => {
    const h = history();
    await h.observe([
      { key: 'acme/app#1', column: 'planning', at: T1 },
      { key: 'acme/app#2', column: 'review', at: T1 },
    ]);
    const since = await h.observe([{ key: 'acme/app#1', column: 'done', at: T2 }]);
    assert.deepEqual([...since], [['acme/app#1', T2]]);
    assert.equal((await h.observe([{ key: 'acme/app#2', column: 'review', at: T3 }])).get('acme/app#2'), T1);
  });

  test('an empty observation returns an empty map', async () => {
    assert.equal((await history().observe([])).size, 0);
  });

  test('refuses a database without the table', () => {
    assert.throws(() => new SqliteWorkColumnHistory(new DatabaseSync(':memory:')), /work_board_columns/);
  });
});
