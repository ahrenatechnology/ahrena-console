// #332: the Workflows page without the cap of 500 (period, pages, active sessions always in) and the tree between sessions.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, type LocalApi } from '../../src/api/index.ts';
import type { DesktopIndex, DesktopSession } from '../../src/api/desktop-index.ts';
import { buildSessionTrees, pageOfTrees, periodStart } from '../../src/api/workflow-tree.ts';
import { agent, session } from '../fixtures.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function get(url: string, path: string): Promise<{ status: number; body: any }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the tree between sessions, as a pure function', () => {
  const s = (id: string, updatedAt: string, startedAt = updatedAt) => ({ id, name: id, status: 'completed' as const, startedAt, updatedAt });
  const lineage = (parents: Record<string, string | null>, known: string[] = []) => ({
    parentOf: (id: string) => (id in parents ? { parentCliId: parents[id], parentKnown: parents[id] !== null || known.includes(id) } : null),
  });

  test('PM → Tech Lead → session → child, one level inside the other', () => {
    const trees = buildSessionTrees([s('pm', ago(1)), s('tl', ago(1)), s('cloud', ago(0.5)), s('kid', ago(0.1))], lineage({ pm: null, tl: 'pm', cloud: 'tl', kid: 'cloud' }));
    assert.equal(trees.length, 1);
    assert.equal(trees[0].sessions, 4);
    assert.deepEqual([trees[0].root.sessionId, trees[0].root.children[0].sessionId, trees[0].root.children[0].children[0].children[0].sessionId], ['pm', 'tl', 'kid']);
    assert.equal(trees[0].root.children[0].children[0].kind, 'child');
  });

  test('a parent outside the period makes the child a root, marked; no lineage makes everyone a root', () => {
    const [t] = buildSessionTrees([s('child', ago(1))], lineage({ child: 'gone' }, ['child']));
    assert.deepEqual([t.root.kind, t.root.parentOutsidePeriod], ['root', true]);
    assert.equal(buildSessionTrees([s('a', ago(1)), s('b', ago(2))], null).length, 2);
  });

  test('a cycle in the index never hangs a tree off itself', () => {
    const trees = buildSessionTrees([s('a', ago(1)), s('b', ago(2))], lineage({ a: 'b', b: 'a' }));
    assert.equal(trees.reduce((t, x) => t + x.sessions, 0), 2);
  });

  test('trees come most recent first, by the latest activity inside the tree', () => {
    const trees = buildSessionTrees([s('old', ago(9)), s('top', ago(5)), s('kid', ago(0.1))], lineage({ kid: 'top' }));
    assert.deepEqual(trees.map((t) => t.root.sessionId), ['top', 'old']);
  });

  test('pages of 50, with an offset cursor that refuses garbage', () => {
    const all = Array.from({ length: 120 }, (_, i) => i);
    assert.deepEqual(pageOfTrees(all, null)!.nextCursor, '50');
    assert.deepEqual(pageOfTrees(all, '100')!.items.length, 20);
    assert.equal(pageOfTrees(all, '100')!.nextCursor, null);
    assert.equal(pageOfTrees(all, 'abc'), null);
    assert.equal(periodStart('all', NOW), null);
    assert.equal(periodStart('24h', NOW), ago(1));
  });
});

describe('GET /api/workflows with a period, pages and the tree', () => {
  let storage: SqliteStorage;
  let api: LocalApi;
  const desktopRows: Record<string, DesktopSession> = {};
  const fakeDesktop = {
    refresh: async () => {},
    sessionByCli: (id: string) => Object.values(desktopRows).find((d) => d.cliSessionId === id) ?? null,
    sessionByLocal: (id: string) => desktopRows[id] ?? null,
  } as unknown as DesktopIndex;
  const row = (cli: string, parentLocal: string | null): DesktopSession => ({ localId: `local_${cli}`, cliSessionId: cli, title: null, branch: null, cwd: null, parentLocalId: parentLocal, archived: false, accounts: [] });

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 'pm', name: 'PM', status: 'active', updatedAt: ago(0.1), startedAt: ago(2) }));
    await storage.putSession(session({ id: 'tl', name: 'Tech Lead', status: 'completed', updatedAt: ago(1), startedAt: ago(2) }));
    await storage.putSession(session({ id: 'work', name: 'Work', status: 'completed', updatedAt: ago(2), startedAt: ago(3) }));
    await storage.putSession(session({ id: 'ancient', name: 'Ancient', status: 'completed', updatedAt: ago(40), startedAt: ago(41) }));
    await storage.putSession(session({ id: 'stale-live', name: 'Stale live', status: 'active', updatedAt: ago(41), startedAt: ago(42) }));
    for (const id of ['pm', 'tl', 'work']) await storage.putAgent(agent({ id: `${id}:main`, sessionId: id, type: 'main', name: null }));
    Object.assign(desktopRows, { local_pm: row('pm', null), local_tl: row('tl', 'local_pm'), local_work: row('work', 'local_tl') });
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: fakeDesktop, trabalho: null, agora: () => NOW });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {} });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('30 days is the default: the old completed session stays out and the old active one is in, counted apart', async () => {
    const { status, body } = await get(api.url, '/api/workflows');
    assert.equal(status, 200);
    assert.equal(body.period, '30d');
    assert.equal(body.sessions, 4);
    assert.equal(body.activeOutsidePeriod, 1);
    const ids = JSON.stringify(body.trees.items);
    assert.ok(ids.includes('stale-live') && !ids.includes('ancient'));
  });

  test('"all" brings everything, "24h" keeps only what moved today plus the active ones', async () => {
    assert.equal((await get(api.url, '/api/workflows?period=all')).body.sessions, 5);
    const day = (await get(api.url, '/api/workflows?period=24h')).body;
    assert.deepEqual(day.trees.items.map((t: any) => t.root.sessionId).sort(), ['pm', 'stale-live']);
    assert.equal(day.activeOutsidePeriod, 1);
  });

  test('the tree PM → Tech Lead → session comes from the Desktop index, with the loop totals per session', async () => {
    const { body } = await get(api.url, '/api/workflows?period=7d');
    const pm = body.trees.items.find((t: any) => t.root.sessionId === 'pm');
    assert.equal(pm.sessions, 3);
    const work = pm.root.children[0].children[0];
    assert.deepEqual([pm.root.children[0].sessionId, work.sessionId, work.kind], ['tl', 'work', 'child']);
    assert.deepEqual(work.loop, { prs: 0, rounds: 0, changeRequests: 0, subagents: 0, stopped: 0 });
    assert.equal(body.loopKpis.prs, 0);
  });

  test('a bad period or cursor is a 400, and a cursor walks the pages', async () => {
    assert.deepEqual((await get(api.url, '/api/workflows?period=year')).body, { error: 'period: 24h, 7d, 30d ou all' });
    assert.deepEqual((await get(api.url, '/api/workflows?cursor=x')).body, { error: 'cursor inválido' });
    const second = (await get(api.url, '/api/workflows?cursor=1')).body;
    assert.equal(second.trees.items.length, 1);
    assert.equal(second.trees.total, 2);
    assert.equal(second.trees.nextCursor, null);
  });

  test('more than 500 sessions are all read: nothing is cut', async () => {
    const big = openSqliteStorage({ path: ':memory:' });
    for (let i = 0; i < 620; i++) await big.putSession(session({ id: `b${i}`, status: 'completed', updatedAt: ago(1 + i / 1000), startedAt: ago(2) }));
    const montador = new MontadorDoPainel({ storage: big, contas: new Accounts({ storage: big, file: null }), desktop: null, trabalho: null, agora: () => NOW });
    const bigApi = await startLocalApi({ panelBuilder: montador, hooks: { storage: big }, port: 0, log: () => {} });
    const { body } = await get(bigApi.url, '/api/workflows');
    assert.equal(body.sessions, 620);
    assert.equal(body.trees.total, 620);
    assert.equal(body.trees.items.length, 50);
    await bigApi.close();
    await big.close();
  });
});
