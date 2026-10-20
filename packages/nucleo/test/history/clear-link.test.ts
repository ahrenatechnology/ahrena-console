// The link across /clear that the history shows (#33): a session's previous and next one,
// read from the decisions' session link (P10), only with the `clear` reason. Synthetic ids.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { clearNeighbours, linkSession } from '../../src/decisions/registry.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { at } from '../fixtures.ts';

test('previous and next across /clear; compaction and child do not count', async () => {
  const storage = openSqliteStorage({ path: ':memory:' });
  const port = new SqliteDecisionStore(storage.db);
  const link = (sessionId: string, parentSessionId: string, reason: 'clear' | 'compact' | 'child', min: number) =>
    linkSession(port, { sessionId, parentSessionId, reason, linkedAt: at(min) }, at(min));
  await link('sim-a', 'sim-raiz', 'compact', 1);
  await link('sim-b', 'sim-a', 'clear', 2);
  await link('sim-c', 'sim-b', 'clear', 3);
  await link('sim-d', 'sim-b', 'child', 4);

  assert.deepEqual(await clearNeighbours(port, 'sim-raiz'), { previous: null, next: null });
  assert.deepEqual(await clearNeighbours(port, 'sim-a'), { previous: null, next: 'sim-b' });
  assert.deepEqual(await clearNeighbours(port, 'sim-b'), { previous: 'sim-a', next: 'sim-c' });
  assert.deepEqual(await clearNeighbours(port, 'sim-c'), { previous: 'sim-b', next: null });
  assert.deepEqual(await clearNeighbours(port, 'sim-d'), { previous: null, next: null });
  assert.deepEqual(await clearNeighbours(port, 'sim-sozinha'), { previous: null, next: null });
  await storage.close();
});
