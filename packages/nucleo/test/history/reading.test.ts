// Reading the history (#33) over the port, with the simulator's P4: the ended sessions by day, the cost
// by the panel's calculation, the neighbours' title across /clear and the core without the decisions.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { SessionHistory, type HistoryItem } from '../../src/history/reading.ts';
import { BEFORE_CLEAR, AFTER_CLEAR, seedPanelHistory } from '../../src/simulator/history-ended.ts';
import { seedPanelScenario, seedPanelDecisions } from '../../src/simulator/panel.ts';
import { T0 } from '../fixtures.ts';

const NOW = Date.parse(T0);

async function p4(withDecisions = true) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisions = withDecisions ? new SqliteDecisionStore(storage.db) : null;
  await seedPanelScenario(storage, 'p4', NOW);
  if (decisions) await seedPanelDecisions(decisions, 'p4', NOW);
  await seedPanelHistory(storage, decisions, 'p4', NOW);
  return { storage, history: new SessionHistory({ storage, decisions, timeZone: 'UTC' }) };
}

const item = (days: { sessions: HistoryItem[] }[], id: string) => days.flatMap((d) => d.sessions).find((s) => s.id === id)!;

describe('history: reading', () => {
  test('P4: only the ended sessions, by day, 7 days per page and the cursor for the rest', async () => {
    const { storage, history } = await p4();
    const p1 = await history.page({ before: null, days: 7, search: null });
    assert.deepEqual(p1.days.map((d) => d.day), ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-28', '2026-10-27', '2026-10-25']);
    assert.deepEqual(p1.days[0].sessions.map((s) => s.id), ['sim-panel-blog-estatico'], 'the scenario\'s active sessions do not go in');
    assert.deepEqual(p1.days[1].sessions.map((s) => s.id), [AFTER_CLEAR, BEFORE_CLEAR]);
    assert.equal(p1.next, '2026-10-25');
    const p2 = await history.page({ before: p1.next, days: 7, search: null });
    assert.deepEqual(p2.days.map((d) => d.day), ['2026-10-24']);
    assert.equal(p2.next, null);
    await storage.close();
  });

  test('the item: model name, final status, duration, cost and the neighbours across /clear with the title', async () => {
    const { storage, history } = await p4();
    const { days } = await history.page({ before: null, days: 31, search: null });
    const after = item(days, AFTER_CLEAR);
    assert.equal(after.title, 'Extrair a cobrança');
    assert.equal(after.project, 'vitrine-demo');
    assert.equal(after.model, 'Opus 5.5');
    assert.equal(after.status, 'completed');
    assert.equal(after.durationMs, 110 * 60_000);
    assert.ok(Math.abs(after.costUsd! - 1.3) < 0.01, `cost ${after.costUsd}`);
    assert.deepEqual(after.previous, { id: BEFORE_CLEAR, title: 'Mapear o módulo de pagamentos' });
    assert.equal(after.next, null);
    assert.deepEqual(item(days, BEFORE_CLEAR).next, { id: AFTER_CLEAR, title: 'Extrair a cobrança' });
    assert.equal(item(days, BEFORE_CLEAR).previous, null);
    assert.equal(item(days, 'sim-history-monthly-report').status, 'error');
    assert.equal(item(days, 'sim-history-discount-rules').status, 'abandoned');
    assert.equal(item(days, 'sim-history-recipe-search').costUsd, null, 'no usage, no cost');
    await storage.close();
  });

  test('the search filters before paging', async () => {
    const { storage, history } = await p4();
    const p = await history.page({ before: null, days: 7, search: 'VITRINE' });
    assert.deepEqual(p.days.map((d) => d.sessions.map((s) => s.id)), [[AFTER_CLEAR, BEFORE_CLEAR]]);
    assert.equal(p.next, null);
    await storage.close();
  });

  test('without the decisions, it works and the neighbours come back null', async () => {
    const { storage, history } = await p4(false);
    const { days } = await history.page({ before: null, days: 31, search: null });
    assert.equal(item(days, AFTER_CLEAR).previous, null);
    assert.equal(item(days, BEFORE_CLEAR).next, null);
    await storage.close();
  });

  test('the session title can come from outside (the Desktop index) and the search sees it', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await seedPanelHistory(storage, null, 'p4', NOW);
    const history = new SessionHistory({ storage, timeZone: 'UTC', titleOf: (s) => (s.id === BEFORE_CLEAR ? 'Título do Desktop' : null) });
    const p = await history.page({ before: null, days: 7, search: 'desktop' });
    assert.deepEqual(p.days.flatMap((d) => d.sessions.map((s) => `${s.id} ${s.title}`)), [`${BEFORE_CLEAR} Título do Desktop`]);
    await storage.close();
  });

  test('in the other scenarios, the simulator records no history', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await seedPanelHistory(storage, null, 'p1', NOW);
    assert.equal((await storage.listSessions()).items.length, 0);
    await storage.close();
  });
});
