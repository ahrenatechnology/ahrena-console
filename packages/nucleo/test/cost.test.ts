// Cost and tokens (item 1.6): editable price table, compaction floor and aggregations.

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import {
  DEFAULT_PRICES,
  aggregateCost,
  applyFloor,
  sessionCost,
  setPrice,
  dayOf,
  currentPrices,
  restoreDefault,
  priceTable,
} from '../src/cost/index.ts';
import { importHistory, mainAgentId, subagentId } from '../src/ingest/history/importer.ts';
import { emptyTokenCounts, type TokenCounts } from '../src/model.ts';
import { estimateCost, resolvePricing } from '../src/pricing.ts';
import { agent, at, event, pricing, session, T0, usage } from './fixtures.ts';

const zero = emptyTokenCounts();
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe('default price table', () => {
  const priceOf = (model: string) => resolvePricing(model, DEFAULT_PRICES);

  test('matches the id and the dated id, with the public prices', () => {
    assert.equal(priceOf('claude-opus-5-5')?.inputPerMTok, 4);
    assert.equal(priceOf('claude-opus-5-5')?.cacheReadPerMTok, 0.2);
    assert.equal(priceOf('claude-sonnet-4-5-20250929')?.outputPerMTok, 15);
    assert.equal(priceOf('claude-haiku-4-5-20251001')?.cacheWrite1hPerMTok, 2);
    assert.equal(priceOf('claude-3-5-haiku-20241022')?.inputPerMTok, 0.8);
    assert.equal(priceOf('claude-opus-4-20250514')?.inputPerMTok, 15);
  });

  test('a neighbouring model does not inherit another one\'s price', () => {
    assert.equal(priceOf('claude-opus-5')?.inputPerMTok, 5);
    assert.equal(priceOf('claude-opus-5-9'), null);
    assert.equal(priceOf('claude-opus-4-9'), null);
    assert.equal(priceOf('claude-3-7-sonnet-20250219'), null);
  });

  test('every row has the five prices and the date they were checked', () => {
    for (const p of DEFAULT_PRICES) {
      for (const k of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWrite5mPerMTok', 'cacheWrite1hPerMTok'] as const) {
        assert.equal(typeof p[k], 'number', `${p.pattern}.${k}`);
      }
      assert.equal(p.updatedAt, '2026-10-18T00:00:00.000Z');
    }
    assert.equal(new Set(DEFAULT_PRICES.map((p) => p.pattern)).size, DEFAULT_PRICES.length);
  });
});

describe('editable price table', () => {
  test('the user\'s override wins over the default, and restoring goes back to the default', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    await setPrice(store, pricing({ pattern: 'claude-opus-5-5', inputPerMTok: 3 }));
    await setPrice(store, pricing({ pattern: 'modelo-interno%', inputPerMTok: 1 }));

    const table = new Map((await priceTable(store)).map((l) => [l.pattern, l]));
    const opus = table.get('claude-opus-5-5')!;
    assert.equal(opus.origin, 'user');
    assert.equal(opus.inputPerMTok, 3);
    assert.equal(opus.name, 'Claude Opus 5.5');
    assert.equal(opus.defaultPrice?.inputPerMTok, 4);
    assert.equal(table.get('modelo-interno%')?.origin, 'user');
    assert.equal(table.get('claude-opus-5-5-20%')?.origin, 'default');
    assert.equal(resolvePricing('claude-opus-5-5', await currentPrices(store))?.inputPerMTok, 3);

    assert.equal(await restoreDefault(store, 'claude-opus-5-5'), 1);
    assert.equal(resolvePricing('claude-opus-5-5', await currentPrices(store))?.inputPerMTok, 4);
    assert.equal(await restoreDefault(store), 1);
    assert.equal(resolvePricing('modelo-interno-1', await currentPrices(store)), null);
    await store.close();
  });

  test('an invalid price is not written', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    await assert.rejects(setPrice(store, pricing({ inputPerMTok: -1 })));
    assert.deepEqual(await store.listModelPricing(), []);
    await store.close();
  });
});

describe('floor after compaction', () => {
  const t = (output: number): TokenCounts => ({ ...zero, output });

  test('with no previous record, the floor is zero', () => {
    assert.deepEqual(applyFloor(null, t(10)), zero);
  });

  test('when the live count drops, what vanished becomes floor and the total does not go down', () => {
    const floor = applyFloor({ tokens: t(100), baseline: zero }, t(10));
    assert.deepEqual(floor, t(90));
    // Then the live count grows again and the floor stays.
    assert.deepEqual(applyFloor({ tokens: t(10), baseline: floor }, t(50)), t(90));
    // A second compaction accumulates.
    assert.deepEqual(applyFloor({ tokens: t(50), baseline: t(90) }, t(5)), t(135));
  });

  test('the cost counts the floor', () => {
    const u = usage({ tokens: zero, baseline: t(1_000_000) });
    assert.equal(estimateCost(u, [pricing()]).costUsd, 50);
  });
});

describe('cost aggregations', () => {
  // input 10 / output 50 per MTok for claude-opus-5%.
  const prices = [pricing()];
  const usageData = (output: number, extra: Record<string, unknown> = {}) => ({
    usage: {
      messageId: null,
      requestId: null,
      model: 'claude-opus-5-5',
      speed: 'standard',
      inferenceGeo: '',
      serviceTier: 'standard',
      contextSize: '',
      tokens: { ...zero, output },
      webSearchRequests: 0,
      webFetchRequests: 0,
      codeExecutionRequests: 0,
      ...extra,
    },
  });

  async function scenario() {
    const store = openSqliteStorage({ path: ':memory:' });
    await store.putSession(session({ id: 's1', updatedAt: at(60 * 24) }));
    await store.putAgent(agent({ id: 'a1' }));
    await store.putAgent(agent({ id: 'a2', type: 'subagent', parentAgentId: 'a1' }));
    // Two lines of the same message (streaming): the final one counts.
    await store.appendEvent(event({ id: 'e1', agentId: 'a1', createdAt: T0, data: usageData(100_000, { messageId: 'm1' }) }));
    await store.appendEvent(event({ id: 'e2', agentId: 'a1', createdAt: T0, data: usageData(200_000, { messageId: 'm1' }) }));
    await store.appendEvent(event({ id: 'e3', agentId: 'a2', createdAt: at(60 * 24), data: usageData(300_000, { messageId: 'm2' }) }));
    // A message from an unpriced model.
    await store.appendEvent(event({ id: 'e4', agentId: 'a2', createdAt: at(60 * 24), data: usageData(1000, { messageId: 'm3', model: 'modelo-novo' }) }));
    // The bucket has 500k live output plus 100k floor: 600k in total, 500k explained by the events.
    await store.putTokenUsage(usage({ tokens: { ...zero, output: 500_000 }, baseline: { ...zero, output: 100_000 }, updatedAt: at(60 * 24) }));
    await store.putTokenUsage(usage({ model: 'modelo-novo', tokens: { ...zero, output: 1000 }, updatedAt: at(60 * 24) }));
    // Another session, bucket only (as the simulator writes it).
    await store.putSession(session({ id: 's2', updatedAt: at(10) }));
    await store.putTokenUsage(usage({ sessionId: 's2', tokens: { ...zero, output: 1_000_000 }, updatedAt: at(10) }));
    return store;
  }

  test('every grouping adds up to the same total, marked as an estimate', async () => {
    const store = await scenario();
    const r = await aggregateCost(store, { prices });
    assert.equal(r.estimate, true);
    assert.equal(r.currency, 'USD');
    near(r.total.costUsd, (600_000 + 1_000_000) * 50 / 1e6);
    for (const lines of [r.bySession, r.byAgent, r.byModel, r.byDay]) {
      near(lines.reduce((s, l) => s + (l.costUsd ?? 0), 0), r.total.costUsd!);
      assert.equal(lines.reduce((s, l) => s + l.totalTokens, 0), r.total.totalTokens);
      assert.ok(lines.every((l) => l.estimate === true));
    }
    await store.close();
  });

  test('by agent: what the events explain goes to the agent; the floor has no agent', async () => {
    const store = await scenario();
    const r = await sessionCost(store, 's1', { prices });
    const byAgent = new Map(r.byAgent.map((l) => [l.agentId, l]));
    near(byAgent.get('a1')!.costUsd, 10);
    near(byAgent.get('a2')!.costUsd, 15);
    assert.deepEqual(byAgent.get('a2')!.unpriced, { models: ['modelo-novo'], totalTokens: 1000 });
    const noAgent = byAgent.get(null)!;
    assert.equal(noAgent.key, 's1:sem-agente');
    assert.equal(noAgent.tokens.output, 100_000);
    near(noAgent.costUsd, 5);
    await store.close();
  });

  test('by model: an unpriced model is "unpriced", not zero', async () => {
    const store = await scenario();
    const r = await aggregateCost(store, { prices });
    const unpriced = r.byModel.find((l) => l.key === 'modelo-novo')!;
    assert.equal(unpriced.costUsd, null);
    assert.deepEqual(unpriced.unpriced, { models: ['modelo-novo'], totalTokens: 1000 });
    assert.equal(r.byModel.at(-1)!.key, 'modelo-novo');
    assert.deepEqual(r.total.unpriced.models, ['modelo-novo']);
    await store.close();
  });

  test('by day, with a period filter and a time zone', async () => {
    const store = await scenario();
    const r = await aggregateCost(store, { prices });
    assert.deepEqual(r.byDay.map((l) => l.key), ['2026-11-02', '2026-11-03']);
    near(r.byDay[0].costUsd, 10 + 50);

    const only3rd = await aggregateCost(store, { prices, since: '2026-11-03', until: '2026-11-03' });
    assert.deepEqual(only3rd.bySession.map((l) => l.key), ['s1']);
    near(only3rd.total.costUsd, 15 + 5);

    // 12:00 UTC is 21:00 in Tokyo, the same day; 23:30 UTC is already the next day there.
    assert.equal(dayOf('2026-11-02T23:30:00.000Z', 'Asia/Tokyo'), '2026-11-03');
    assert.equal(dayOf('2026-11-02T23:30:00.000Z'), '2026-11-02');
    await store.close();
  });

  test('no usage, zero cost and no lines', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    const r = await aggregateCost(store);
    assert.equal(r.total.costUsd, 0);
    assert.deepEqual(r.bySession, []);
    await store.close();
  });
});

describe('end-to-end cost with the imported history', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ahrena-cost-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const S1 = '00000000-0000-4000-8000-000000000001';
  const S2 = '00000000-0000-4000-8000-000000000002';

  test('imports, prices by the table in force and splits among agents', async () => {
    const root = join(tmp, 'projects');
    cpSync(join(import.meta.dirname, 'fixtures', 'history', 'projects'), root, { recursive: true });
    const store = openSqliteStorage({ path: ':memory:' });
    await importHistory({ storage: store, root });

    const r = await aggregateCost(store);
    const buckets = [...(await store.listTokenUsage(S1)), ...(await store.listTokenUsage(S2))];
    const prices = await currentPrices(store);
    const expected = buckets.reduce((s, b) => s + (estimateCost(b, prices).costUsd ?? 0), 0);
    near(r.total.costUsd, expected);

    // The events explain all of S1's usage: nothing is left without an agent.
    const s1 = await sessionCost(store, S1);
    const agents = s1.byAgent.map((l) => l.agentId);
    assert.ok(!agents.includes(null));
    assert.ok(agents.includes(mainAgentId(S1)) && agents.includes(subagentId(S1, 'a1111111111111111')));
    assert.ok(s1.byAgent.every((l) => l.costUsd !== null && l.costUsd > 0));

    // S2 uses fast mode on a model with no fast price: "unpriced".
    const s2 = await sessionCost(store, S2);
    assert.equal(s2.total.costUsd, null);
    assert.ok(s2.total.unpriced.totalTokens > 0);
    await store.close();
  });
});
