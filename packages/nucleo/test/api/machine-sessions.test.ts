import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
// #243: `?machine=` on the list routes and the Detail, against a remote núcleo faked on loopback. The
// "remote" is a real API over its own simulated database, behind a proxy that plays the tunnel: it
// takes only `GET` with the remote's own Host, records every path, and can be slowed down, closed,
// or made to answer a bad shape. Synthetic data only: the simulator's sessions, no real machine.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, FeedDeEventos, LeiturasDoDetalhe, ListaDeSessoes, MontadorDoPainel, QuadroKanban, startLocalApi, type ApiOptions, type LocalApi } from '../../src/api/index.ts';
import { decodeCursor, encodeCursor } from '../../src/api/machine-sessions.ts';
import { MachineReader } from '../../src/api/machine-reader.ts';
import { SessionHistory } from '../../src/history/reading.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { simulate } from '../../src/simulator/index.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { localMachine, TelemetryService, type MachineStatus } from '../../src/telemetry/service.ts';
import { closedPort } from '../telemetry/fake-remote.ts';
import { reading } from '../telemetry/reading.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const LOCAL = { id: 'local', label: 'Esta máquina' };
const WS = { id: 'ws-test', label: 'Workstation' };

interface Core {
  storage: SqliteStorage;
  api: LocalApi;
  sessions: ListaDeSessoes;
}

/** A núcleo over a simulated database: every list route and the Detail. */
async function startCore(seed: number, extra: Partial<ApiOptions> = {}, storage?: SqliteStorage): Promise<Core> {
  const own = !storage;
  storage ??= openSqliteStorage({ path: ':memory:' });
  if (own) await simulate(storage, { seed, sessions: 14, chaos: true, prices: true, now: () => NOW });
  const accounts = new Accounts({ storage, file: null });
  const fleet = new FleetReader({ storage, accounts, now: () => NOW, timeZone: 'UTC' });
  const panelBuilder = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null, agora: () => NOW });
  const sessionList = new ListaDeSessoes({ storage, contas: accounts, agora: () => NOW });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN,
    panelBuilder,
    hooks: { storage },
    port: 0,
    log: () => {},
    sessions: sessionList,
    kanban: new QuadroKanban({ storage, contas: accounts, agora: () => NOW }),
    history: new SessionHistory({ storage, timeZone: 'UTC' }),
    events: new FeedDeEventos({ storage }),
    fleet,
    detail: new LeiturasDoDetalhe({ storage, montador: panelBuilder, agora: () => NOW }),
    ...extra,
  });
  return { storage, api, sessions: sessionList };
}

/** The tunnel in front of the remote núcleo. */
interface Tunnel {
  port: number;
  paths: string[];
  delayMs: number;
  override: Map<string, unknown>;
  close(): Promise<void>;
}

async function startTunnel(target: string): Promise<Tunnel> {
  const sockets = new Set<import('node:net').Socket>();
  const t: Tunnel = { port: 0, paths: [], delayMs: 0, override: new Map(), close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:4720' || req.headers.origin) return json(403, { error: 'origem não permitida' });
    t.paths.push(req.url ?? '');
    if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (t.override.has(path)) return json(200, t.override.get(path));
    try {
      const r = await fetch(`${target}${req.url}`);
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch {
      res.destroy();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.port = (server.address() as { port: number }).port;
  t.close = () =>
    new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return t;
}

let remote: Core;
let local: Core;
let tunnel: Tunnel;
let status: MachineStatus;
let clock: number;
let reader: MachineReader;
let store: SqliteTelemetryStore;

const get = async (path: string) => {
  const r = await fetch(`${local.api.url}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, any>, text: '' };
};
const remoteGet = async (path: string) => (await fetch(`${remote.api.url}${path}`)).json() as Promise<Record<string, any>>;

async function bootLocal(options: { port?: number; timeoutMs?: number } = {}) {
  const source = { id: WS.id, label: WS.label, port: options.port ?? tunnel.port, status: () => status };
  const entry = { ...source, state: () => status.state };
  store = new SqliteTelemetryStore(local?.storage.db ?? openSqliteStorage({ path: ':memory:' }).db);
  reader = new MachineReader({ get: loopbackGet({ timeoutMs: 5_000 }), machines: () => [source], now: () => clock, ttlMs: 5_000, timeoutMs: options.timeoutMs ?? 2_000 });
  const telemetry = new TelemetryService({ store, tracker: new AlertTracker(), machines: [localMachine(), entry], now: () => NOW });
  return { machineReader: reader, telemetry };
}

before(async () => {
  remote = await startCore(243);
});
after(async () => {
  await remote.api.close();
  remote.storage.close();
});

beforeEach(async () => {
  tunnel = await startTunnel(remote.api.url);
  status = { state: 'connected', reason: null, version: 1 };
  clock = NOW;
  const storage = openSqliteStorage({ path: ':memory:' });
  await simulate(storage, { seed: 176, sessions: 14, chaos: true, prices: true, now: () => NOW });
  local = { storage, api: null as unknown as LocalApi, sessions: null as unknown as ListaDeSessoes };
  local = await startCore(0, await bootLocal(), storage);
});
afterEach(async () => {
  await local.api.close();
  local.storage.close();
  await tunnel.close();
});

/** Every page of `/api/sessions` for `query`. */
async function allPages(query: string) {
  const first = await get(`/api/sessions?${query}`);
  const items = [...first.body.items];
  for (let page = 2; page <= first.body.pages; page++) items.push(...(await get(`/api/sessions?${query}&page=${page}`)).body.items);
  return { first: first.body, items };
}

describe('#243 ?machine= on /api/sessions', () => {
  test('without machine the answer is the one of before, byte for byte, even with a remote configured', async () => {
    const plain = await startCore(0, {}, local.storage);
    try {
      for (const path of ['/api/sessions', '/api/sessions?status=idle&page=2', '/api/wall', '/api/kanban', '/api/kanban?view=agents', '/api/history', '/api/events', '/api/dashboard', '/api/sessions?machine=']) {
        const [a, b] = await Promise.all([fetch(`${local.api.url}${path}`).then((r) => r.text()), fetch(`${plain.api.url}${path}`).then((r) => r.text())]);
        assert.equal(a, b, path);
        assert.doesNotMatch(a, /"machines?"/, path);
      }
      const r = await fetch(`${local.api.url}/api/sessions`).then((x) => x.text());
      assert.equal(r, JSON.stringify(await local.sessions.listar({ status: 'all', busca: null, dir: null, ordem: 'activity', sentido: 'desc', pagina: 1, perPage: 10 })));
    } finally {
      await plain.api.close();
    }
    assert.deepEqual(tunnel.paths, [], 'no remote read without machine');
  });

  test('machine=all merges both machines, then paginates; counts, directories and byMachine cover both', async () => {
    const own = await local.sessions.listar({ status: 'all', busca: null, dir: null, ordem: 'activity', sentido: 'desc', pagina: 1, perPage: 100 });
    const theirs = await remoteGet('/api/sessions?perPage=100');
    const { first, items } = await allPages('machine=all&perPage=5');
    assert.equal(first.total, own.total + theirs.total);
    assert.equal(first.registered, own.registered + theirs.registered);
    assert.equal(first.perPage, 5);
    assert.equal(first.pages, Math.ceil(first.total / 5));
    assert.equal(items.length, first.total);
    assert.equal(new Set(items.map((i) => `${i.machine.id}/${i.id}`)).size, items.length, 'no row repeated across pages');
    assert.deepEqual(
      items.filter((i) => i.machine.id === 'ws-test').map((i) => i.id),
      theirs.items.map((i: { id: string }) => i.id),
      'the remote rows keep their order',
    );
    for (let k = 1; k < items.length; k++) assert.ok(items[k - 1].lastActivity >= items[k].lastActivity, 'newest first across machines');
    for (const i of items) assert.deepEqual(i.machine, i.machine.id === 'local' ? LOCAL : WS);
    assert.equal(first.counts.all, first.total);
    assert.equal(first.counts.blocked, own.counts.blocked + theirs.counts.blocked);
    assert.deepEqual(first.directories, [...new Set([...own.directories, ...theirs.directories])].sort());
    assert.deepEqual(first.byMachine, [
      { id: 'local', registered: own.registered, total: own.total },
      { id: 'ws-test', registered: theirs.registered, total: theirs.total },
    ]);
    assert.deepEqual(first.machines, [
      { ...LOCAL, state: 'connected', reason: null, lastReadAt: null },
      { ...WS, state: 'connected', reason: null, lastReadAt: null },
    ]);
    // The remote is read without `machine`, never `machine=all`.
    assert.ok(tunnel.paths.length > 0);
    for (const p of tunnel.paths) assert.doesNotMatch(p, /machine=/);
  });

  test('machine=all keeps the filters and the order on both machines', async () => {
    const { first, items } = await allPages('machine=all&status=completed&order=duration&direction=asc&perPage=4');
    const theirs = await remoteGet('/api/sessions?status=completed&perPage=100');
    assert.equal(first.total, (await local.sessions.listar({ status: 'completed', busca: null, dir: null, ordem: 'activity', sentido: 'desc', pagina: 1, perPage: 10 })).total + theirs.total);
    for (const i of items) assert.equal(i.status, 'completed');
    for (let k = 1; k < items.length; k++) assert.ok(items[k - 1].durationMs <= items[k].durationMs, 'shortest first');
  });

  test('machine=local gives only this machine, marked; machine=<remote> only the remote', async () => {
    const own = await local.sessions.listar({ status: 'all', busca: null, dir: null, ordem: 'activity', sentido: 'desc', pagina: 1, perPage: 10 });
    const l = await get('/api/sessions?machine=local');
    assert.equal(l.status, 200);
    assert.deepEqual(
      l.body.items.map((i: { id: string }) => i.id),
      own.items.map((i) => i.id),
    );
    assert.ok(l.body.items.every((i: { machine: unknown }) => JSON.stringify(i.machine) === JSON.stringify(LOCAL)));
    assert.deepEqual(l.body.machines, [{ ...LOCAL, state: 'connected', reason: null, lastReadAt: null }]);
    assert.deepEqual(tunnel.paths, [], 'machine=local never reads the remote');

    const theirs = await remoteGet('/api/sessions');
    const w = await get('/api/sessions?machine=ws-test');
    assert.equal(w.body.total, theirs.total);
    assert.deepEqual(
      w.body.items.map((i: { id: string }) => i.id),
      theirs.items.map((i: { id: string }) => i.id),
    );
    assert.ok(w.body.items.every((i: { machine: unknown; open: unknown }) => JSON.stringify(i.machine) === JSON.stringify(WS) && JSON.stringify(i.open) === JSON.stringify({ target: 'remote', command: null })));
    assert.deepEqual(
      w.body.machines.map((m: { id: string }) => m.id),
      ['ws-test'],
    );
  });

  test('an unknown or malformed machine gives 400 with the explanation', async () => {
    for (const m of ['nope', 'Bad_Id', '../x', 'local,ws-test']) {
      const r = await get(`/api/sessions?machine=${encodeURIComponent(m)}`);
      assert.equal(r.status, 400, m);
      assert.match(r.body.error, /^machine: /);
    }
    assert.equal((await get('/api/wall?machine=nope')).status, 400);
    assert.equal((await get('/api/sessions?machine=all&status=nope')).status, 400);
  });

  test('a remote that does not answer in time leaves the local answer within the deadline', async () => {
    await local.api.close();
    local = await startCore(0, await bootLocal({ timeoutMs: 300 }), local.storage);
    tunnel.delayMs = 10_000;
    const t0 = performance.now();
    const r = await get('/api/sessions?machine=all');
    const ms = performance.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(ms < 2_000, `${Math.round(ms)} ms`);
    assert.ok(r.body.items.length > 0);
    assert.ok(r.body.items.every((i: { machine: { id: string } }) => i.machine.id === 'local'));
    assert.deepEqual(
      r.body.byMachine.map((b: { id: string }) => b.id),
      ['local'],
    );
  });

  test('a remote that is down adds nothing, answers 200 and says its state and last reading', async () => {
    status = { state: 'unreachable', reason: 'port-closed', version: null };
    await store.putSample(WS.id, reading({}, NOW - 600_000), 12 * 3_600_000);
    const r = await get('/api/sessions?machine=all');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.every((i: { machine: { id: string } }) => i.machine.id === 'local'));
    assert.deepEqual(r.body.machines[1], { ...WS, state: 'unreachable', reason: 'port-closed', lastReadAt: new Date(NOW - 600_000).toISOString() });
    assert.deepEqual(tunnel.paths, [], 'a machine that is not connected is not even asked');
    // Connected by the poll, but the tunnel is gone by now: still 200, still only this machine.
    await local.api.close();
    local = await startCore(0, await bootLocal({ port: await closedPort() }), local.storage);
    status = { state: 'connected', reason: null, version: 1 };
    const again = await get('/api/sessions?machine=all');
    assert.equal(again.status, 200);
    assert.ok(again.body.items.every((i: { machine: { id: string } }) => i.machine.id === 'local'));
  });

  test('a second call within the cache window makes no new remote request; after it, one', async () => {
    await get('/api/sessions?machine=all');
    const n = tunnel.paths.length;
    assert.ok(n > 0);
    await Promise.all([get('/api/sessions?machine=all'), get('/api/sessions?machine=ws-test')]);
    assert.equal(tunnel.paths.length, n, 'machine=ws-test reads the same remote page as machine=all, from the cache');
    clock += 4_000;
    await get('/api/sessions?machine=all');
    assert.equal(tunnel.paths.length, n);
    clock += 2_000;
    await get('/api/sessions?machine=all');
    assert.equal(tunnel.paths.length, n + 1);
  });

  test('a read past the deadline goes on; meanwhile a recent good answer is used, and not an old one', async () => {
    await local.api.close();
    local = await startCore(0, await bootLocal({ timeoutMs: 300 }), local.storage);
    const fresh = await get('/api/sessions?machine=ws-test');
    assert.ok(fresh.body.items.length > 0);
    tunnel.delayMs = 1_000;
    clock += 6_000;
    const t0 = performance.now();
    const late = await get('/api/sessions?machine=ws-test');
    assert.ok(performance.now() - t0 < 900);
    assert.deepEqual(late.body.items, fresh.body.items, 'the last good answer, 6 s old');
    clock += 40_000;
    const old = await get('/api/sessions?machine=ws-test');
    assert.equal(old.body.items.length, 0, 'past 30 s it is no longer used');
  });

    test('concurrent calls join the read in flight', async () => {
    tunnel.delayMs = 100;
    await Promise.all([get('/api/sessions?machine=all'), get('/api/sessions?machine=all'), get('/api/sessions?machine=all')]);
    assert.equal(tunnel.paths.filter((p) => p.startsWith('/api/sessions?')).length, 1);
  });

  test('remote items without the shape are dropped; a remote of the remote is never passed on', async () => {
    const good = (await remoteGet('/api/sessions')).items[0];
    tunnel.override.set('/api/sessions', {
      total: 5,
      registered: 5,
      page: 1,
      perPage: 100,
      pages: 1,
      directories: ['/ok', 'relative', 7],
      counts: { all: 5, active: 'x' },
      items: [
        { ...good, account: { label: 'equipe', color: 'red;background:url(x)' }, open: { target: 'terminal', command: 'rm -rf /' } },
        { ...good, id: 'from-another', machine: { id: 'other', label: 'Outra' } },
        { ...good, id: 'no-status', status: 'weird' },
        { ...good, id: '../../etc', lastActivity: 'yesterday' },
        'junk',
      ],
    });
    const r = await get('/api/sessions?machine=ws-test');
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    const [row] = r.body.items;
    assert.deepEqual(row.open, { target: 'remote', command: null });
    assert.match(row.account.color, /^#[0-9a-f]{6}$/i);
    assert.deepEqual(r.body.directories, ['/ok']);
    assert.equal(r.body.counts.active, 0);
    tunnel.override.set('/api/sessions', { items: 'nope' });
    clock += 10_000;
    const bad = await get('/api/sessions?machine=all');
    assert.equal(bad.status, 200);
    assert.ok(bad.body.items.every((i: { machine: { id: string } }) => i.machine.id === 'local'));
  });
});

describe('#243 ?machine= on the other lists', () => {
  test('wall: the cards of both machines, in the wall order, recounted', async () => {
    const own = (await get('/api/wall')).body;
    const theirs = await remoteGet('/api/wall');
    const r = (await get('/api/wall?machine=all')).body;
    assert.equal(r.cards.length, own.cards.length + theirs.cards.length);
    assert.equal(r.count.all, own.count.all + theirs.count.all);
    assert.equal(r.count.blocked, own.count.blocked + theirs.count.blocked);
    const rank = (c: { attention: { level: string } | null }) => (c.attention?.level === 'blocked' ? 0 : c.attention?.level === 'idle' ? 1 : 2);
    for (let k = 1; k < r.cards.length; k++) assert.ok(rank(r.cards[k - 1]) <= rank(r.cards[k]));
    assert.deepEqual(
      r.byMachine.map((b: { id: string; count: { all: number } }) => [b.id, b.count.all]),
      [
        ['local', own.count.all],
        ['ws-test', theirs.count.all],
      ],
    );
    assert.ok(r.cards.filter((c: { machine: { id: string } }) => c.machine.id === 'ws-test').every((c: { open: unknown }) => JSON.stringify(c.open) === JSON.stringify({ target: 'remote', command: null })));
  });

  test('kanban: each column adds both machines, page by page', async () => {
    const own = (await get('/api/kanban')).body;
    const theirs = await remoteGet('/api/kanban');
    const r = (await get('/api/kanban?machine=all')).body;
    assert.equal(r.view, 'sessions');
    for (const col of r.columns) {
      const a = own.columns.find((c: { id: string }) => c.id === col.id);
      const b = theirs.columns.find((c: { id: string }) => c.id === col.id);
      assert.equal(col.total, a.total + b.total, col.id);
      assert.equal(col.items.length, Math.min(10, col.total), col.id);
      assert.equal(col.hasMore, col.total > 10);
    }
    const busiest = r.columns.reduce((x: { total: number }, y: { total: number }) => (y.total > x.total ? y : x));
    if (busiest.total > 10) {
      const p2 = (await get(`/api/kanban?machine=all&column=${busiest.id}&page=2`)).body;
      const seen = new Set(busiest.items.map((i: { machine: { id: string }; id: string }) => `${i.machine.id}/${i.id}`));
      for (const i of p2.columns[0].items) assert.ok(!seen.has(`${i.machine.id}/${i.id}`));
    }
    const agents = (await get('/api/kanban?machine=ws-test&view=agents')).body;
    assert.ok(agents.columns.flatMap((c: { items: unknown[] }) => c.items).every((i: { machine: { id: string } }) => i.machine.id === 'ws-test'));
  });

  test('events: both feeds newest first, with one cursor for both', async () => {
    const r = (await get('/api/events?machine=all&limit=5')).body;
    const machines = new Set(r.events.map((e: { machine: { id: string } }) => e.machine.id));
    assert.deepEqual([...machines].sort(), ['local', 'ws-test']);
    for (let k = 1; k < r.events.length; k++) assert.ok(r.events[k - 1].createdAt >= r.events[k].createdAt);
    assert.ok(r.options.sessions.some((s: { machine: { id: string } }) => s.machine.id === 'ws-test'));
    const older = decodeCursor(r.older);
    assert.deepEqual(Object.keys(older ?? {}).sort(), ['local', 'ws-test']);
    const next = (await get(`/api/events?machine=all&limit=5&before=${r.older}`)).body;
    const first = new Set(r.events.map((e: { machine: { id: string }; id: string }) => `${e.machine.id}/${e.id}`));
    assert.ok(next.events.length > 0);
    for (const e of next.events) assert.ok(!first.has(`${e.machine.id}/${e.id}`));
    assert.equal(next.options, null);
    assert.equal((await get('/api/events?machine=all&before=not-a-cursor')).status, 400);
    assert.equal((await get('/api/events?machine=all&limit=999')).status, 400);
  });

  test('events: a remote down at load joins the live feed when it comes back', async () => {
    status = { state: 'unreachable', reason: 'port-closed', version: null };
    const r = (await get('/api/events?machine=all&limit=5')).body;
    assert.ok(r.events.every((e: { machine: { id: string } }) => e.machine.id === 'local'));
    const cursor = decodeCursor(r.cursor);
    assert.ok(cursor && typeof cursor.local === 'string');
    assert.equal(cursor?.['ws-test'] ?? null, null);
    status = { state: 'connected', reason: null, version: 1 };
    const live = (await get(`/api/events?machine=all&limit=5&after=${r.cursor}`)).body;
    assert.ok(live.events.some((e: { machine: { id: string } }) => e.machine.id === 'ws-test'));
    for (let k = 1; k < live.events.length; k++) assert.ok(live.events[k - 1].createdAt >= live.events[k].createdAt);
    assert.equal(live.options, null);
    const next = decodeCursor(live.cursor);
    assert.equal(typeof next?.['ws-test'], 'string');
  });

  test('history: the days of both machines, newest first, with the page cursor', async () => {
    const r = (await get('/api/history?machine=all&days=31')).body;
    const machines = new Set(r.days.flatMap((d: { sessions: { machine: { id: string } }[] }) => d.sessions.map((s) => s.machine.id)));
    assert.deepEqual([...machines].sort(), ['local', 'ws-test']);
    const days = r.days.map((d: { day: string }) => d.day);
    assert.deepEqual(days, [...days].sort().reverse());
    const one = (await get('/api/history?machine=all&days=1')).body;
    assert.equal(one.days.length, 1);
    assert.equal(one.next, r.days.length > 1 ? one.days[0].day : null);
  });

  test('history: days of either machine interleave, are cut at `days`, and `next` resumes after the last kept', async () => {
    const item = (await remoteGet('/api/history')).days[0].sessions[0];
    const at = (day: string, id: string) => ({ ...item, id, start: `${day}T09:00:00.000Z`, end: `${day}T10:00:00.000Z` });
    tunnel.override.set('/api/history', {
      days: [
        { day: '2026-11-01', sessions: [at('2026-11-01', 'remote-a')] },
        { day: '2026-10-30', sessions: [at('2026-10-30', 'remote-b'), { ...at('2026-10-30', 'remote-c'), status: 'weird' }] },
      ],
      next: null,
    });
    const own = (await get('/api/history')).body.days.map((d: { day: string }) => d.day);
    const all = (await get('/api/history?machine=all&days=31')).body;
    assert.deepEqual(
      all.days.map((d: { day: string }) => d.day),
      [...new Set([...own, '2026-11-01', '2026-10-30'])].sort().reverse(),
    );
    assert.equal(all.next, null);
    assert.deepEqual(
      all.days.at(-1).sessions.map((s: { id: string }) => s.id),
      ['remote-b'],
    );
    const two = (await get('/api/history?machine=all&days=2')).body;
    assert.equal(two.days.length, 2);
    assert.equal(two.next, two.days[1].day);
  });

  test('dashboard: the numbers add both machines, with each one apart', async () => {
    const own = (await get('/api/dashboard')).body;
    const theirs = await remoteGet('/api/dashboard');
    const r = (await get('/api/dashboard?machine=all')).body;
    assert.equal(r.numbers.sessions.total, own.numbers.sessions.total + theirs.numbers.sessions.total);
    assert.equal(r.numbers.agents.active, own.numbers.agents.active + theirs.numbers.agents.active);
    assert.equal(r.numbers.events.total, own.numbers.events.total + theirs.numbers.events.total);
    assert.equal(r.agents.length, own.agents.length + theirs.agents.length);
    assert.deepEqual(
      r.byMachine.map((b: { id: string; numbers: { sessions: { total: number } } }) => [b.id, b.numbers.sessions.total]),
      [
        ['local', own.numbers.sessions.total],
        ['ws-test', theirs.numbers.sessions.total],
      ],
    );
  });
});

describe('#243 the Detail of a remote session', () => {
  test('the header and the tabs are read from the remote, marked, without "Abrir no Claude Desktop"', async () => {
    const id = (await remoteGet('/api/sessions')).items[0].id as string;
    const r = await get(`/api/sessions/${id}?machine=ws-test`);
    assert.equal(r.status, 200);
    assert.equal(r.body.session.id, id);
    assert.deepEqual(r.body.machine, WS);
    assert.deepEqual(r.body.open, { target: 'remote', command: null });
    assert.equal(r.body.local, null);
    assert.equal(r.body.opensSession, false);
    const tab = await get(`/api/sessions/${id}/events?machine=ws-test&limit=3`);
    assert.equal(tab.status, 200);
    assert.deepEqual(tab.body.machine, WS);
    assert.ok(tunnel.paths.includes(`/api/sessions/${id}/events?limit=3`));
    const missing = await get('/api/sessions/does-not-exist?machine=ws-test');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body.machine, WS);
  });

  test('only the known Detail paths and a valid id go to the remote', async () => {
    const id = (await remoteGet('/api/sessions')).items[0].id as string;
    tunnel.paths.length = 0;
    const other = await get(`/api/sessions/${id}/messaging?machine=ws-test`);
    assert.notEqual(other.status, 200);
    assert.equal((await get('/api/sessions/bad%20id?machine=ws-test')).status, 400);
    assert.equal((await get(`/api/sessions/${id}?machine=all`)).status, 400);
    assert.equal((await get(`/api/sessions/${id}?machine=ws-test&${'x'.repeat(40)}=1`)).status, 400);
    assert.deepEqual(tunnel.paths, []);
  });

  test('with the remote down, 503 machine-unreachable with its state', async () => {
    status = { state: 'unreachable', reason: 'no-response', version: null };
    const r = await get('/api/sessions/some-session?machine=ws-test');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: 'machine-unreachable', machine: { ...WS, state: 'unreachable', lastReadAt: null } });
  });
});

describe('#243 the cursor of machine=all', () => {
  test('round-trips, and refuses what it did not make', () => {
    const c = encodeCursor({ local: 'abc_1', 'ws-test': null });
    assert.ok(c && /^[A-Za-z0-9_-]+$/.test(c));
    assert.deepEqual(decodeCursor(c!), { local: 'abc_1', 'ws-test': null });
    assert.equal(encodeCursor({ local: null }), null);
    assert.equal(decodeCursor(Buffer.from('{"BAD":"x"}').toString('base64url')), null);
    assert.equal(decodeCursor(Buffer.from('{"local":"a b"}').toString('base64url')), null);
    assert.equal(decodeCursor('!!'), null);
  });
});

describe('#243 MachineReader', () => {
  const source = (state: MachineStatus['state'] = 'connected') => ({ id: 'ws-test', label: 'Workstation', port: 1, status: (): MachineStatus => ({ state, reason: null, version: 1 }) });

  test('a slow read is reused for twice what it took, so polling never keeps the remote busy', async () => {
    let now = 0;
    let calls = 0;
    const r = new MachineReader({
      machines: () => [],
      now: () => now,
      get: async () => {
        calls++;
        now += 10_000;
        return { kind: 'response', status: 200, body: { ok: true } };
      },
    });
    assert.deepEqual(await r.read(source(), '/api/dashboard'), { ok: true });
    now += 15_000;
    await r.read(source(), '/api/dashboard');
    assert.equal(calls, 1);
    now += 6_000;
    await r.read(source(), '/api/dashboard');
    assert.equal(calls, 2);
  });

  test('only a connected machine is read, and only a 200 with JSON is a body', async () => {
    let calls = 0;
    const r = new MachineReader({
      machines: () => [],
      get: async (_port, path) => {
        calls++;
        return path === '/a' ? { kind: 'response', status: 500, body: { error: 'x' } } : { kind: 'unreachable', reason: 'port-closed' };
      },
    });
    assert.equal(await r.read(source('unreachable'), '/a'), null);
    assert.equal(await r.read(source('incompatible-version'), '/a'), null);
    assert.equal(calls, 0);
    assert.equal(await r.read(source(), '/a'), null);
    assert.deepEqual(await r.answer(source(), '/a'), { status: 500, body: { error: 'x' } });
    assert.equal(await r.answer(source(), '/b'), null);
  });
});
