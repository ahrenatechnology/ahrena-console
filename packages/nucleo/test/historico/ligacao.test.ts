// A ligação depois do /clear que o histórico mostra (#33): a anterior e a seguinte de uma sessão,
// lidas da ligação de sessões das decisões (P10), só com o motivo `clear`. Ids sintéticos.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { clearNeighbours, linkSession } from '../../src/decisoes/registro.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { at } from '../fixtures.ts';

test('anterior e seguinte pelo /clear; compactação e filha não contam', async () => {
  const storage = openSqliteStorage({ path: ':memory:' });
  const porta = new SqliteDecisionStore(storage.db);
  const ligar = (sessionId: string, parentSessionId: string, reason: 'clear' | 'compact' | 'filha', min: number) =>
    linkSession(porta, { sessionId, parentSessionId, reason, linkedAt: at(min) }, at(min));
  await ligar('sim-a', 'sim-raiz', 'compact', 1);
  await ligar('sim-b', 'sim-a', 'clear', 2);
  await ligar('sim-c', 'sim-b', 'clear', 3);
  await ligar('sim-d', 'sim-b', 'filha', 4);

  assert.deepEqual(await clearNeighbours(porta, 'sim-raiz'), { previous: null, next: null });
  assert.deepEqual(await clearNeighbours(porta, 'sim-a'), { previous: null, next: 'sim-b' });
  assert.deepEqual(await clearNeighbours(porta, 'sim-b'), { previous: 'sim-a', next: 'sim-c' });
  assert.deepEqual(await clearNeighbours(porta, 'sim-c'), { previous: 'sim-b', next: null });
  assert.deepEqual(await clearNeighbours(porta, 'sim-d'), { previous: null, next: null });
  assert.deepEqual(await clearNeighbours(porta, 'sim-sozinha'), { previous: null, next: null });
  await storage.close();
});
