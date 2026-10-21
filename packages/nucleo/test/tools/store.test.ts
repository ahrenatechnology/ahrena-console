// #280 layer 1, decision 0014 section 2: migration 12 creates `tool_checks`; the store replaces a
// machine's rows at once and a check is valid for 6 h.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS } from '../../src/adapters/sqlite/migrations.ts';
import { CHECK_VALIDITY_MS, MemoryToolChecksStore, SqliteToolChecksStore, validChecks, type ToolCheck } from '../../src/tools/store.ts';

const NOW = Date.parse('2026-10-21T09:12:00.000Z');
const check = (toolId: string, checkedAt = NOW): ToolCheck => ({ toolId, sourceId: 'homebrew', installed: '2.81.0', latest: '2.83.1', checkedAt, error: null });

describe('#280 tool_checks', () => {
  test('migration 12 is the last one and adds the table', () => {
    assert.equal(MIGRATIONS.at(-1)?.version, 12);
    const storage = openSqliteStorage({ path: ':memory:' });
    const cols = (storage.db.prepare('PRAGMA table_info(tool_checks)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['machine_id', 'tool_id', 'source_id', 'installed', 'latest', 'checked_at', 'error']);
  });

  for (const [name, make] of [
    ['sqlite', () => new SqliteToolChecksStore(openSqliteStorage({ path: ':memory:' }).db)],
    ['memory', () => new MemoryToolChecksStore()],
  ] as const) {
    test(`${name}: replace swaps the machine's rows and leaves other machines alone`, () => {
      const store = make();
      store.replace('local', [check('gh'), { ...check('jq'), latest: null, error: 'network' }]);
      store.replace('ws-exemplo', [check('git')]);
      store.replace('local', [check('gh', NOW + 1)]);
      assert.deepEqual(store.list('local'), [check('gh', NOW + 1)]);
      assert.deepEqual(store.list('ws-exemplo'), [check('git')]);
      assert.deepEqual(store.list('nope'), []);
    });
  }

  test('a check is valid for 6 h', () => {
    const rows = [check('a', NOW - CHECK_VALIDITY_MS + 1), check('b', NOW - CHECK_VALIDITY_MS), check('c', NOW + 60_000)];
    assert.deepEqual(validChecks(rows, NOW).map((c) => c.toolId), ['a']);
    assert.equal(CHECK_VALIDITY_MS, 6 * 3600 * 1000);
  });

  test('the SQLite store refuses a database without the migration', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    assert.throws(() => new SqliteToolChecksStore(new DatabaseSync(':memory:')), /tool_checks/);
  });
});
