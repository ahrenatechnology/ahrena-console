// #319: the panel of a session that runs on a remote machine (P14), against a remote núcleo faked on
// loopback, as in machine-sessions.test.ts: a real API over its own simulated database, behind a
// proxy that plays the tunnel (only `GET`, the remote's own Host), records every path and can answer
// a fixed body per path. Synthetic data only: the simulator's sessions, no real machine.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, ListaDeSessoes, MontadorDoPainel, startLocalApi, type ApiOptions, type LocalApi } from '../../src/api/index.ts';
import { MAX_REMOTE_PANEL_BYTES, minimalPanel, remotePanel, RemoteSessionMap } from '../../src/api/machine-panel.ts';
import { connectionFromStatus, MachineReader, type ConnectionOf } from '../../src/api/machine-reader.ts';
import { simulate } from '../../src/simulator/index.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { localMachine, TelemetryService, type MachineStatus } from '../../src/telemetry/service.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const WS = { id: 'ws-test', label: 'Workstation' };
const UP = { state: 'up', since: null, lastError: null };

interface Core {
  storage: SqliteStorage;
  api: LocalApi;
}

async function startCore(storage: SqliteStorage, extra: Partial<ApiOptions> = {}): Promise<Core> {
  const accounts = new Accounts({ storage, file: null });
  const panelBuilder = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null, agora: () => NOW });
  const api = await startLocalApi({
    panelBuilder,
    hooks: { storage },
    port: 0,
    log: () => {},
    sessions: new ListaDeSessoes({ storage, contas: accounts, agora: () => NOW }),
    ...extra,
  });
  return { storage, api };
}

async function seeded(seed: number): Promise<SqliteStorage> {
  const storage = openSqliteStorage({ path: ':memory:' });
  await simulate(storage, { seed, sessions: 14, chaos: true, prices: true, now: () => NOW });
  return storage;
}

/** The tunnel in front of the remote núcleo. */
interface Tunnel {
  port: number;
  paths: string[];
  methods: string[];
  override: Map<string, unknown>;
  close(): Promise<void>;
}

async function startTunnel(target: string): Promise<Tunnel> {
  const sockets = new Set<import('node:net').Socket>();
  const t: Tunnel = { port: 0, paths: [], methods: [], override: new Map(), close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    t.methods.push(req.method ?? '');
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:4720' || req.headers.origin) return json(403, { error: 'origem não permitida' });
    t.paths.push(req.url ?? '');
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
/** The same storage as `local`, without any remote machine: the answers of before. */
let plain: Core;
let tunnel: Tunnel;
let status: MachineStatus;
let clock: number;
let connectionOf: ConnectionOf | null;

const get = async (core: Core, path: string) => {
  const r = await fetch(`${core.api.url}${path}`);
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as Record<string, any> };
};
const remoteSessionIds = async (): Promise<string[]> => (await get(remote, '/api/sessions?perPage=100')).body.items.map((i: { id: string }) => i.id);
const localSessionId = async (): Promise<string> => (await get(local, '/api/sessions')).body.items[0].id;

function machineOptions(): Partial<ApiOptions> {
  const source = { id: WS.id, label: WS.label, port: tunnel.port, status: () => status };
  const store = new SqliteTelemetryStore(openSqliteStorage({ path: ':memory:' }).db);
  const machineReader = new MachineReader({
    get: loopbackGet({ timeoutMs: 5_000 }),
    machines: () => [source],
    now: () => clock,
    timeoutMs: 2_000,
    connectionOf: (id) => connectionOf?.(id),
  });
  const telemetry = new TelemetryService({ store, tracker: new AlertTracker(), machines: [localMachine(), { ...source, state: () => status.state }], now: () => NOW });
  return { machineReader, telemetry };
}

before(async () => {
  remote = await startCore(await seeded(243));
});
after(async () => {
  await remote.api.close();
  remote.storage.close();
});

beforeEach(async () => {
  tunnel = await startTunnel(remote.api.url);
  status = { state: 'connected', reason: null, version: 1 };
  clock = NOW;
  connectionOf = null;
  const storage = await seeded(176);
  local = await startCore(storage, machineOptions());
  plain = await startCore(storage);
});
afterEach(async () => {
  await local.api.close();
  await plain.api.close();
  local.storage.close();
  await tunnel.close();
});

/** The remote's panel of `id` as the remote itself answers it. */
const remotePanelOf = async (id: string, query = '') => (await get(remote, `/api/panel/${id}${query}`)).body;

describe('#319 the panel of a session of this Mac', () => {
  test('is the answer of before, byte for byte, and asks no remote (AC-2)', async () => {
    const id = await localSessionId();
    for (const query of ['', '?decisions=family', '?account=acc-1&org=org-1&cwd=%2Ftmp%2Fx&model=claude-x']) {
      const [a, b] = await Promise.all([get(local, `/api/panel/${id}${query}`), get(plain, `/api/panel/${id}${query}`)]);
      assert.equal(a.status, 200);
      assert.equal(a.text, b.text, query);
      assert.equal(a.body.machine, undefined);
    }
    assert.deepEqual(tunnel.paths, []);
  });

  test('an id no machine knows keeps the "Sessão nova" panel of before', async () => {
    const [a, b] = await Promise.all([get(local, '/api/panel/nobody-knows-this?cwd=%2Ftmp'), get(plain, '/api/panel/nobody-knows-this?cwd=%2Ftmp')]);
    assert.equal(a.status, 200);
    assert.equal(a.text, b.text);
    assert.equal(a.body.machine, undefined);
    assert.equal(a.body.session.reason, 'session_start');
    assert.ok(tunnel.paths.includes('/api/panel/nobody-knows-this?cwd=%2Ftmp'), 'the remote was asked');
  });

  test('an invalid id is 400 as before, and no remote is asked', async () => {
    const [a, b] = await Promise.all([get(local, '/api/panel/bad%20id'), get(plain, '/api/panel/bad%20id')]);
    assert.equal(a.status, 400);
    assert.equal(a.text, b.text);
    assert.deepEqual(tunnel.paths, []);
  });
});

describe('#319 the panel of a remote session', () => {
  test('is read from the remote with the mod query, marked with machine, and read-only (AC-3)', async () => {
    const [id] = await remoteSessionIds();
    const query = '?decisions=family&account=acc-1&cwd=%2Fsrv%2Fapp&other=dropped';
    const r = await get(local, `/api/panel/${id}${query}`);
    assert.equal(r.status, 200);
    assert.ok(tunnel.paths.includes(`/api/panel/${id}?account=acc-1&cwd=%2Fsrv%2Fapp&decisions=family`), tunnel.paths.join(' '));
    assert.ok(tunnel.paths.every((p) => !p.includes('other=')));
    assert.equal(r.body.session.id, id);
    assert.deepEqual(r.body.machine, { ...WS, lastReadAt: new Date(NOW).toISOString(), connection: UP });
    // The same panel the remote builds, with only what this Mac must not offer taken out.
    const own = await remotePanelOf(id!, '?decisions=family&account=acc-1&cwd=%2Fsrv%2Fapp');
    assert.equal(r.body.session.title, own.session.title);
    assert.deepEqual(r.body.cost, own.cost);
    assert.equal(r.body.api.opensSession, false);
    assert.ok(r.body.children.every((c: { local: unknown }) => c.local === null));
    assert.ok([...r.body.needYou.machine, ...r.body.needYou.family].every((i: { local: unknown }) => i.local === null));
    if (r.body.decisions) {
      assert.equal(r.body.decisions.toConfirm, 0);
      for (const d of r.body.decisions.list?.items ?? []) {
        assert.notEqual(d.state, 'to_confirm');
        assert.equal(d.undo, null);
      }
    }
  });

  test('a remote decision to confirm is never offered: no Confirmar or Descartar', () => {
    const own = minimalPanel(NOW);
    const body = {
      ...own,
      session: { id: 's1', title: 'x' },
      cost: { usd: 0, series: [], estimate: true },
      decisions: { current: 1, toConfirm: 1, resume: null, list: { scope: 'family', current: 1, toConfirm: 1, items: [{ id: 'd1', state: 'to_confirm' }, { id: 'd2', state: 'current', undo: 'confirm' }] } },
      children: [{ id: 'c1', local: 'local_00000000-0000-0000-0000-000000000000' }],
      prs: { total: 2, items: [{ url: 'https://github.com/o/r/pull/1', session: { local: 'local_x' } }, { url: 'javascript:alert(1)', session: {} }] },
      work: { pr: { url: 'http://evil.example/' } },
    };
    const p = remotePanel(body, 's1') as Record<string, any>;
    assert.deepEqual(p.decisions.list.items, [{ id: 'd2', state: 'current', undo: null }]);
    assert.equal(p.decisions.toConfirm, 0);
    assert.equal(p.children[0].local, null);
    assert.deepEqual(p.prs, { total: 1, items: [{ url: 'https://github.com/o/r/pull/1', session: { local: null } }] });
    assert.equal(p.work.pr, null);
  });

  test("the remote's own machine is never passed on: its panel is dropped", async () => {
    const [id] = await remoteSessionIds();
    tunnel.override.set(`/api/panel/${id}`, { ...(await remotePanelOf(id!)), machine: { id: 'deeper', label: 'Outra', lastReadAt: null, connection: UP } });
    const r = await get(local, `/api/panel/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.machine, undefined, 'the local "Sessão nova" panel, not the remote of the remote');
    assert.equal(r.body.session.reason, 'session_start');
  });

  test('a panel without the shape is dropped; text, keys and size are capped', async () => {
    const [a, b, c] = await remoteSessionIds();
    const good = await remotePanelOf(a!);
    // Another session's panel: dropped.
    tunnel.override.set(`/api/panel/${a}`, { ...good, session: { ...good.session, id: 'someone-else' } });
    assert.equal((await get(local, `/api/panel/${a}`)).body.machine, undefined);
    // Long text cut, odd keys left out.
    const other = await remotePanelOf(b!);
    tunnel.override.set(`/api/panel/${b}`, { ...other, session: { ...other.session, title: 'x'.repeat(10_000), 'bad key': 1 } });
    const capped = await get(local, `/api/panel/${b}`);
    assert.equal(capped.body.session.title.length, 4_000);
    assert.equal(capped.body.session['bad key'], undefined);
    assert.equal(capped.body.machine.id, WS.id);
    // Past MAX_REMOTE_PANEL_BYTES once capped: dropped.
    const third = await remotePanelOf(c!);
    const huge = Array.from({ length: 1_000 }, (_, i) => ({ id: `c${i}`, title: 'y'.repeat(4_000) }));
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) > MAX_REMOTE_PANEL_BYTES);
    tunnel.override.set(`/api/panel/${c}`, { ...third, children: huge });
    assert.equal((await get(local, `/api/panel/${c}`)).body.machine, undefined);
  });

  test('machine.connection comes from the injected provider, its fields only', async () => {
    const [id] = await remoteSessionIds();
    connectionOf = (machineId) =>
      machineId === WS.id
        ? Promise.resolve({ state: 'up', since: '2026-11-02T11:00:00.000Z', lastError: null, command: { start: ['ssh'] }, logFile: '/tmp/x.log' } as never)
        : null;
    const r = await get(local, `/api/panel/${id}`);
    assert.deepEqual(r.body.machine.connection, { state: 'up', since: '2026-11-02T11:00:00.000Z', lastError: null });
    connectionOf = () => Promise.reject(new Error('boom'));
    clock += 10_000;
    assert.deepEqual((await get(local, `/api/panel/${id}`)).body.machine.connection, UP, 'a failing provider falls back to the status');
  });

  test('only GET reaches the remote; the legacy /api/painel route stays 404', async () => {
    const [id] = await remoteSessionIds();
    const post = await fetch(`${local.api.url}/api/panel/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 405);
    const [a, b] = await Promise.all([get(local, `/api/painel/${id}`), get(plain, `/api/painel/${id}`)]);
    assert.equal(a.status, 404);
    assert.equal(a.text, b.text);
    assert.deepEqual(tunnel.paths, []);
    await get(local, `/api/panel/${id}`);
    assert.ok(tunnel.methods.every((m) => m === 'GET'));
  });
});

describe('#319 a remote session this Mac imported a copy of', () => {
  /** This Mac imported the remote session's transcript: same id, `source: 'import'`, no hooks. */
  const importCopy = async (id: string) => {
    const s = (await remote.storage.getSession(id))!;
    await local.storage.putSession({ ...s, source: 'import', status: 'completed' });
  };

  test('the remote that knows it (with its hooks) wins over the imported copy', async () => {
    const [id] = await remoteSessionIds();
    await importCopy(id!);
    const r = await get(local, `/api/panel/${id}`);
    assert.equal(r.body.machine.id, WS.id);
    assert.equal(r.body.session.status, (await remotePanelOf(id!)).session.status);
  });

  test('an imported session no remote knows keeps the panel of before', async () => {
    const own = (await get(local, '/api/sessions')).body.items[0].id as string;
    const s = (await local.storage.getSession(own))!;
    await local.storage.putSession({ ...s, source: 'import' });
    const [a, b] = await Promise.all([get(local, `/api/panel/${own}`), get(plain, `/api/panel/${own}`)]);
    assert.equal(a.text, b.text);
    assert.ok(tunnel.paths.includes(`/api/panel/${own}`), 'the remote was asked');
  });

  test('remote down: its last panel with the band; without one, the imported copy as before', async () => {
    const [a, b] = await remoteSessionIds();
    await importCopy(a!);
    await importCopy(b!);
    await get(local, `/api/panel/${a}`);
    await get(local, '/api/sessions?machine=all&perPage=100');
    status = { state: 'unreachable', reason: 'no-response', version: null };
    const withLast = await get(local, `/api/panel/${a}`);
    assert.equal(withLast.body.machine.connection.state, 'failing');
    const [copy, before] = await Promise.all([get(local, `/api/panel/${b}`), get(plain, `/api/panel/${b}`)]);
    assert.equal(copy.text, before.text);
  });
});

describe('#319 a remote session whose remote is down (AC-1)', () => {
  test('gets its last good panel, with the connection state and when it was read', async () => {
    const [id] = await remoteSessionIds();
    const up = await get(local, `/api/panel/${id}`);
    assert.equal(up.body.machine.connection.state, 'up');
    clock += 60_000;
    status = { state: 'unreachable', reason: 'no-response', version: null };
    tunnel.paths.length = 0;
    const down = await get(local, `/api/panel/${id}`);
    assert.equal(down.status, 200);
    assert.deepEqual(tunnel.paths, [], 'a machine down is not even asked');
    assert.equal(down.body.session.id, id);
    assert.equal(down.body.session.title, up.body.session.title);
    assert.deepEqual(down.body.machine, {
      ...WS,
      lastReadAt: new Date(NOW).toISOString(),
      connection: { state: 'failing', since: null, lastError: { reason: 'core-not-answering', at: null, exitCode: null, holder: null } },
    });
  });

  test('known only from a list read, with no panel yet: the minimal panel the band is drawn on', async () => {
    const all = await get(local, '/api/sessions?machine=all&perPage=100');
    const remoteIds = all.body.items.filter((i: { machine: { id: string } }) => i.machine.id === WS.id).map((i: { id: string }) => i.id);
    assert.ok(remoteIds.length > 0);
    status = { state: 'unreachable', reason: 'port-closed', version: null };
    const r = await get(local, `/api/panel/${remoteIds[0]}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.version, 1);
    assert.equal(r.body.session, null);
    assert.equal(r.body.machine.id, WS.id);
    assert.deepEqual(r.body.machine.connection, { state: 'failing', since: null, lastError: { reason: 'port-closed', at: null, exitCode: null, holder: null } });
    assert.deepEqual(Object.keys(r.body).sort(), [...Object.keys(minimalPanel(NOW)), 'machine'].sort());
  });

  test('a remote that answers too slowly or badly is also served from the last panel, never 5xx', async () => {
    const [id] = await remoteSessionIds();
    await get(local, `/api/panel/${id}`);
    clock += 60_000;
    tunnel.override.set(`/api/panel/${id}`, { version: 1, nonsense: true });
    const r = await get(local, `/api/panel/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.session.id, id);
    assert.equal(r.body.machine.lastReadAt, new Date(NOW).toISOString());
  });

  test('a remote that says it no longer knows the session is believed: back to the local panel', async () => {
    const [id] = await remoteSessionIds();
    const own = await remotePanelOf(id!);
    await get(local, `/api/panel/${id}`);
    clock += 60_000;
    tunnel.override.set(`/api/panel/${id}`, { ...own, cost: null });
    const r = await get(local, `/api/panel/${id}`);
    assert.equal(r.body.machine, undefined);
  });
});

describe('#319 RemoteSessionMap', () => {
  test('remembers for the TTL, is bounded, and keeps the newest', () => {
    let now = 0;
    const map = new RemoteSessionMap({ now: () => now, ttlMs: 1_000, maxSessions: 3, maxPanels: 1 });
    map.noteSessions('ws', ['a', 'b', 'bad id', 42]);
    assert.equal(map.ownerOf('a'), 'ws');
    assert.equal(map.ownerOf('bad id'), null);
    map.notePanel('ws', 'c', { version: 1 }, now);
    map.notePanel('ws', 'd', { version: 1 }, now);
    assert.deepEqual(map.size, { sessions: 3, panels: 1 });
    assert.equal(map.ownerOf('a'), null, 'the oldest went first');
    assert.equal(map.lastPanel('ws', 'c'), null);
    assert.deepEqual(map.lastPanel('ws', 'd')?.body, { version: 1 });
    assert.equal(map.lastPanel('other', 'd'), null);
    now = 1_000;
    assert.equal(map.ownerOf('d'), null);
    assert.equal(map.lastPanel('ws', 'd'), null);
    map.noteSessions('ws', []);
    assert.deepEqual(map.size, { sessions: 0, panels: 0 });
  });
});

describe('#319 connectionFromStatus (until #320 is wired)', () => {
  test('connected is up; unreachable is failing with the reason; not configured is down', () => {
    assert.deepEqual(connectionFromStatus({ state: 'connected', reason: null, version: 1 }), UP);
    assert.equal(connectionFromStatus({ state: 'unreachable', reason: 'no-response', version: null }).lastError?.reason, 'core-not-answering');
    assert.equal(connectionFromStatus({ state: 'unreachable', reason: 'port-closed', version: null }).lastError?.reason, 'port-closed');
    assert.equal(connectionFromStatus({ state: 'incompatible-version', reason: null, version: 0 }).state, 'failing');
    assert.deepEqual(connectionFromStatus({ state: 'not-configured', reason: null, version: null }), { state: 'down', since: null, lastError: null });
  });
});
