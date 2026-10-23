// #262: the panel's need-you across machines (`?needYou=`), against a remote núcleo faked on loopback,
// as in machine-panel.test.ts: a real API over its own simulated database, behind a proxy that plays
// the tunnel (only `GET`, the remote's own Host), records every path and can answer a fixed body per
// path. Synthetic data only: the simulator's sessions and made-up items, no real machine.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, ListaDeSessoes, MontadorDoPainel, startLocalApi, type ApiOptions, type LocalApi } from '../../src/api/index.ts';
import { MachineReader, type ConnectionOf } from '../../src/api/machine-reader.ts';
import { MAX_ITEMS, PanelMachines } from '../../src/api/panel-machines.ts';
import type { NeedsYouItem } from '../../src/api/types.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { simulate } from '../../src/simulator/index.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import type { ConnectionStatus } from '../../src/telemetry/model.ts';
import { localMachine, TelemetryService, type MachineStatus } from '../../src/telemetry/service.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const WS = { id: 'ws-test', label: 'Workstation' };
const SINCE = '2026-11-02T11:00:00.000Z';

function connectionFor(s: MachineStatus): ConnectionStatus {
  const up = s.state === 'connected';
  return {
    configured: true,
    state: up ? 'up' : 'failing',
    since: SINCE,
    ports: [],
    cloud: null,
    lastError: up ? null : { reason: 'sso-expired', at: '2026-11-02T11:58:00.000Z', exitCode: null, holder: null },
    actions: { start: !up, stop: up, reconnect: true, loginAndStart: !up },
    command: { start: ['ssh', 'example-tunnel'], stop: null, startTimeoutSeconds: 60, stopTimeoutSeconds: null },
    job: null,
    logFile: '/tmp/reconnect.log',
  } as ConnectionStatus;
}

interface Core {
  storage: SqliteStorage;
  api: LocalApi;
  builder: MontadorDoPainel;
}

async function startCore(storage: SqliteStorage, extra: Partial<ApiOptions> = {}): Promise<Core> {
  const accounts = new Accounts({ storage, file: null });
  const builder = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null, agora: () => NOW });
  const api = await startLocalApi({
    panelBuilder: builder,
    hooks: { storage },
    port: 0,
    log: () => {},
    sessions: new ListaDeSessoes({ storage, contas: accounts, agora: () => NOW }),
    fleet: new FleetReader({ storage, accounts, now: () => NOW, timeZone: 'UTC' }),
    ...extra,
  });
  return { storage, api, builder };
}

async function seeded(seed: number): Promise<SqliteStorage> {
  const storage = openSqliteStorage({ path: ':memory:' });
  await simulate(storage, { seed, sessions: 14, chaos: true, prices: true, now: () => NOW });
  return storage;
}

interface Tunnel {
  port: number;
  paths: string[];
  override: Map<string, unknown>;
  close(): Promise<void>;
}

async function startTunnel(target: string): Promise<Tunnel> {
  const sockets = new Set<import('node:net').Socket>();
  const t: Tunnel = { port: 0, paths: [], override: new Map(), close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
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
let tunnel: Tunnel;
let status: MachineStatus;
let reader: MachineReader;
let connectionOf: ConnectionOf | null;

function machineOptions(): Partial<ApiOptions> {
  const source = { id: WS.id, label: WS.label, port: tunnel.port, status: () => status };
  const store = new SqliteTelemetryStore(openSqliteStorage({ path: ':memory:' }).db);
  reader = new MachineReader({ get: loopbackGet({ timeoutMs: 5_000 }), machines: () => [source], now: () => NOW, timeoutMs: 2_000, connectionOf: (id) => connectionOf?.(id) ?? null });
  const telemetry = new TelemetryService({ store, tracker: new AlertTracker(), machines: [localMachine(), { ...source, state: () => status.state }], now: () => NOW });
  return { machineReader: reader, telemetry };
}

const get = async (core: Core, path: string) => {
  const r = await fetch(`${core.api.url}${path}`);
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as Record<string, any> };
};
const localSessionId = async (): Promise<string> => (await get(local, '/api/sessions')).body.items[0].id;
const localItems = (id: string): Promise<NeedsYouItem[]> => local.builder.needYouItems(id);

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** A made-up remote attention item (the remote's `GET /api/attention`). */
function attentionItem(session: string, reason: 'permission' | 'question' | 'your-turn' | 'error', ago: number, account: { label: string; color: string } | null = null) {
  return { session, title: `Remote ${session}`, project: 'demo', account, level: reason === 'your-turn' ? 'your-turn' : 'needs', reason, since: minutesAgo(ago), minutes: ago, longReason: `waits (${reason})`, local: null, machine: null };
}

/** A made-up remote wall card for `session`. */
function wallCard(session: string, ago: number, text: string) {
  return {
    id: session,
    title: `Card ${session}`,
    project: 'demo',
    branch: null,
    status: 'waiting',
    state: 'waiting',
    reason: 'notification',
    urgent: true,
    attention: { level: 'blocked', reason: 'permission' },
    since: minutesAgo(ago),
    activity: { type: 'permission', text, since: minutesAgo(ago) },
    model: 'claude-example',
  };
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
  connectionOf = (id) => (id === WS.id ? Promise.resolve(connectionFor(status)) : null);
  local = await startCore(await seeded(176), machineOptions());
});
afterEach(async () => {
  await local.api.close();
  local.storage.close();
  await tunnel.close();
});

describe('#262 the panel without needYou', () => {
  test('is the builder answer byte for byte and reads no remote, with a connected remote', async () => {
    const id = await localSessionId();
    for (const query of ['', '?needYou=', '?needYou=bad%20value', '?needYou=%2Fetc', `?needYou=${'x'.repeat(65)}`]) {
      const r = await get(local, `/api/panel/${id}${query}`);
      assert.equal(r.status, 200);
      assert.equal(r.text, JSON.stringify(await local.builder.montar({ sessionId: id })), query);
      assert.equal(r.body.needYou.items, undefined);
      assert.equal(r.body.needYou.scope, undefined);
    }
    assert.equal(reader.requests, 0);
    assert.deepEqual(tunnel.paths, []);
  });
});

describe('#262 needYou=all', () => {
  test('merges a connected remote: marked items, needs first then your-turn, oldest first, counts of both', async () => {
    const id = await localSessionId();
    const mine = (await localItems(id)).filter((i) => i.id !== id);
    const sharedLabel = mine.find((i) => i.level === 'needs' && i.account)?.account?.label ?? 'conta exemplo';
    tunnel.override.set('/api/attention', {
      items: [
        attentionItem('remote-a', 'permission', 30, { label: sharedLabel, color: '#112233' }),
        attentionItem('remote-b', 'your-turn', 90, { label: 'Remote only', color: 'not-a-color' }),
        attentionItem('remote-c', 'question', 5000, null),
      ],
    });
    tunnel.override.set('/api/wall', { version: 1, cards: [wallCard('remote-a', 30, 'Bash: npm test')] });

    const r = await get(local, `/api/panel/${id}?needYou=all`);
    assert.equal(r.status, 200);
    const n = r.body.needYou;
    assert.equal(n.scope, 'all');
    // The remote is read with its own routes, never with needYou.
    assert.ok(tunnel.paths.includes('/api/attention') && tunnel.paths.includes('/api/wall'), tunnel.paths.join(' '));
    assert.ok(tunnel.paths.every((p) => !p.includes('needYou')));

    const items = n.items as (NeedsYouItem & { machine: { id: string; label: string } | null })[];
    const remoteOnes = items.filter((i) => i.machine !== null);
    assert.deepEqual(remoteOnes.map((i) => i.id).sort(), ['remote-a', 'remote-b', 'remote-c']);
    assert.ok(remoteOnes.every((i) => i.machine!.id === WS.id && i.machine!.label === WS.label && i.local === null && i.relation === null && i.sameProject === false));
    assert.equal(items.filter((i) => i.machine === null).length, Math.min(mine.length, MAX_ITEMS - 3));
    // The wall card enriches its item; the others keep the attention's fields.
    const a = remoteOnes.find((i) => i.id === 'remote-a')!;
    assert.equal(a.title, 'Card remote-a');
    assert.equal(a.text, 'Bash: npm test');
    assert.equal(a.model, 'claude-example');
    assert.equal(a.urgent, true);
    assert.equal(a.reason, 'notification');
    const b = remoteOnes.find((i) => i.id === 'remote-b')!;
    assert.equal(b.title, 'Remote remote-b');
    assert.equal(b.text, 'waits (your-turn)');
    assert.match(b.account!.color, /^#[0-9a-f]{6}$/i);

    // needs first, then your-turn; in each, the oldest since first.
    const levels = items.map((i) => i.level);
    assert.deepEqual(levels, [...levels].sort((x, y) => (x === 'needs' ? 0 : 1) - (y === 'needs' ? 0 : 1)));
    for (const level of ['needs', 'your-turn']) {
      const times = items.filter((i) => i.level === level).map((i) => Date.parse(i.since));
      assert.deepEqual(times, [...times].sort((x, y) => x - y), level);
    }
    assert.equal(items[0]!.id, 'remote-c', 'the oldest need comes first');

    const localNeeds = mine.filter((i) => i.level === 'needs').length;
    assert.equal(n.total, localNeeds + 2);
    assert.equal(n.yourTurn, mine.length - localNeeds + 1);
    assert.deepEqual(n.byMachine, [
      { id: 'local', label: 'Esta máquina', n: localNeeds },
      { id: WS.id, label: WS.label, n: 2 },
    ]);
    assert.equal(
      n.byAccount.reduce((s: number, x: { n: number }) => s + x.n, 0),
      n.total,
    );
    const labels = n.byAccount.map((x: { account: { label: string } | null }) => x.account?.label ?? null);
    assert.equal(new Set(labels).size, labels.length, 'accounts merged by label');
    const shared = n.byAccount.find((x: { account: { label: string } | null }) => x.account?.label === sharedLabel);
    assert.equal(shared.n, mine.filter((i) => i.level === 'needs' && i.account?.label === sharedLabel).length + 1);

    // family and machine keep their lists, each item with machine: null.
    const before = await local.builder.montar({ sessionId: id });
    assert.deepEqual(
      n.machine.map((i: { id: string }) => i.id),
      before.needYou.machine.map((i) => i.id),
    );
    assert.ok([...n.machine, ...n.family].every((i: { machine: unknown }) => i.machine === null));

    assert.deepEqual(n.machines, [{ id: WS.id, label: WS.label, state: 'connected', reason: null, lastReadAt: null, connection: { state: 'up', since: SINCE, lastError: null }, since: null }]);
  });

  test('a real remote núcleo contributes its waiting sessions', async () => {
    const id = await localSessionId();
    const theirs = ((await get(remote, '/api/attention')).body.items as { session: string }[]).map((i) => i.session);
    assert.ok(theirs.length > 0, 'the simulated remote has sessions waiting on you');
    const r = await get(local, `/api/panel/${id}?needYou=${WS.id}`);
    const items = r.body.needYou.items as { id: string; machine: { id: string } | null; title: string; text: string }[];
    assert.deepEqual(items.map((i) => i.id).sort(), theirs.slice(0, MAX_ITEMS).sort());
    assert.ok(items.every((i) => i.machine?.id === WS.id && typeof i.title === 'string' && typeof i.text === 'string'));
  });
});

describe('#262 a remote that is down', () => {
  test('contributes nothing; its entry has state, reason and since; never 5xx', async () => {
    status = { state: 'unreachable', reason: 'no-response', version: null };
    const id = await localSessionId();
    const mine = (await localItems(id)).filter((i) => i.id !== id);
    const r = await get(local, `/api/panel/${id}?needYou=all`);
    assert.equal(r.status, 200);
    const n = r.body.needYou;
    assert.ok(n.items.every((i: { machine: unknown }) => i.machine === null));
    assert.equal(n.total, mine.filter((i) => i.level === 'needs').length);
    assert.equal(n.byMachine[1].n, 0);
    const [m] = n.machines;
    assert.equal(m.id, WS.id);
    assert.equal(m.state, 'unreachable');
    assert.ok('reason' in m);
    assert.equal(m.connection.state, 'failing');
    assert.equal(m.since, SINCE, 'when the connection is not up, its since');
    assert.deepEqual(tunnel.paths, []);
    // Its own scope answers an empty list, still 200.
    const own = await get(local, `/api/panel/${id}?needYou=${WS.id}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.needYou.scope, WS.id);
    assert.deepEqual(own.body.needYou.items, []);
  });

  test('without a connection source, since is lastReadAt (null when never read)', async () => {
    status = { state: 'unreachable', reason: 'port-closed', version: null };
    connectionOf = null;
    const r = await get(local, `/api/panel/${await localSessionId()}?needYou=all`);
    assert.equal(r.body.needYou.machines[0].connection, null);
    assert.equal(r.body.needYou.machines[0].since, null);
  });
});

describe('#262 the scopes', () => {
  beforeEach(() => {
    tunnel.override.set('/api/attention', { items: [attentionItem('remote-a', 'permission', 30), attentionItem('remote-b', 'your-turn', 10)] });
    tunnel.override.set('/api/wall', { version: 1, cards: [] });
  });

  test('local is this Mac only, the remote id is that remote only', async () => {
    const id = await localSessionId();
    const l = (await get(local, `/api/panel/${id}?needYou=local`)).body.needYou;
    assert.equal(l.scope, 'local');
    assert.ok(l.items.every((i: { machine: unknown }) => i.machine === null));
    const w = (await get(local, `/api/panel/${id}?needYou=${WS.id}`)).body.needYou;
    assert.equal(w.scope, WS.id);
    assert.deepEqual(
      w.items.map((i: { id: string }) => i.id),
      ['remote-a', 'remote-b'],
    );
    // The counts are of every machine, whatever the scope.
    assert.equal(l.total, w.total);
    assert.deepEqual(l.byMachine, w.byMachine);
  });

  test('family is the panel family, ordered oldest first, marked with the panel machine', async () => {
    const item = (id: string, level: NeedsYouItem['level'], ago: number, relation: NeedsYouItem['relation']): NeedsYouItem => ({
      id,
      level,
      why: level === 'needs' ? 'permission' : 'your-turn',
      local: null,
      title: id,
      state: 'waiting',
      reason: null,
      urgent: false,
      since: minutesAgo(ago),
      text: '',
      model: null,
      relation,
      sameProject: false,
      account: null,
    });
    // The builder's own order: needs first, the most recent first.
    const family = [item('mother', 'needs', 5, 'parent'), item('sister', 'needs', 50, 'sibling'), item('daughter', 'your-turn', 1, 'child')];
    const body = { needYou: { total: 2, yourTurn: 1, byAccount: [], family, machine: family } };
    const machines = new PanelMachines({ local: { needYouItems: async () => family } });
    const url = (q: string) => new URL(`http://127.0.0.1/api/panel/me?needYou=${q}`);
    const f = (await machines.decorate(body, 'me', url('family'))).needYou as Record<string, any>;
    assert.equal(f.scope, 'family');
    assert.deepEqual(
      f.items.map((i: { id: string }) => i.id),
      ['sister', 'mother', 'daughter'],
    );
    assert.ok([...f.items, ...f.family, ...f.machine].every((i: { machine: unknown }) => i.machine === null));
    assert.deepEqual(f.byMachine, [{ id: 'local', label: 'Esta máquina', n: 2 }]);
    assert.deepEqual(f.machines, []);
    // A remote session's panel (#319): its family is the remote's, marked with it.
    const remoteBody = { ...body, machine: { id: WS.id, label: WS.label, lastReadAt: null, connection: null } };
    const r = (await new PanelMachines({ local: { needYouItems: async () => [] } }).decorate(remoteBody, 'me', url('family'))).needYou as Record<string, any>;
    assert.ok([...r.items, ...r.family, ...r.machine].every((i: { machine: unknown }) => JSON.stringify(i.machine) === JSON.stringify({ id: WS.id, label: WS.label })));
    assert.equal(r.items.length, 3);
    // Without the parameter, the same object.
    assert.equal(await machines.decorate(body, 'me', new URL('http://127.0.0.1/api/panel/me')), body);
  });

  test('an unknown well-formed id answers as all', async () => {
    const id = await localSessionId();
    const all = (await get(local, `/api/panel/${id}?needYou=all`)).body.needYou;
    const gone = await get(local, `/api/panel/${id}?needYou=removed-machine`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.needYou.scope, 'all');
    assert.deepEqual(gone.body.needYou.items, all.items);
  });

  test('a malformed value is treated as absent', async () => {
    const id = await localSessionId();
    const r = await get(local, `/api/panel/${id}?needYou=no%20way`);
    assert.equal(r.text, JSON.stringify(await local.builder.montar({ sessionId: id })));
  });
});

describe('#262 what a remote sends', () => {
  test('an answer without the shape adds nothing', async () => {
    const id = await localSessionId();
    for (const body of [{ items: 'nope' }, [], { items: [{ session: 'x' }] }, { nothing: true }]) {
      await local.api.close();
      local.storage.close();
      tunnel.override.set('/api/attention', body);
      local = await startCore(await seeded(176), machineOptions());
      const r = await get(local, `/api/panel/${id}?needYou=all`);
      assert.equal(r.status, 200);
      assert.ok(r.body.needYou.items.every((i: { machine: unknown }) => i.machine === null), JSON.stringify(body));
      assert.equal(r.body.needYou.byMachine[1].n, 0);
    }
  });

  test('items carrying their own machine are dropped, and the list holds at most 24', async () => {
    const id = await localSessionId();
    const many = Array.from({ length: 40 }, (_, k) => attentionItem(`remote-${k}`, 'permission', 1000 + k));
    tunnel.override.set('/api/attention', { items: [...many, { ...attentionItem('remote-of-remote', 'permission', 9999), machine: { id: 'other', label: 'Other' } }] });
    tunnel.override.set('/api/wall', { cards: [{ ...wallCard('remote-0', 1000, 'x'), machine: { id: 'other', label: 'Other' } }] });
    const n = (await get(local, `/api/panel/${id}?needYou=${WS.id}`)).body.needYou;
    assert.equal(n.items.length, MAX_ITEMS);
    assert.ok(n.items.every((i: { id: string }) => i.id !== 'remote-of-remote'));
    assert.equal(n.items[0].title, 'Remote remote-39', 'the oldest first; a card with a machine does not enrich');
    assert.equal(n.byMachine[1].n, 40);
  });
});

describe('#262 the session the panel is open on', () => {
  test('is never listed, on this Mac', async () => {
    const waiting = (await localItems('nobody'))[0];
    assert.ok(waiting, 'the simulated Mac has a session waiting on you');
    tunnel.override.set('/api/attention', { items: [attentionItem(waiting.id, 'permission', 30)] });
    const n = (await get(local, `/api/panel/${waiting.id}?needYou=all`)).body.needYou;
    assert.ok(n.items.every((i: { id: string }) => i.id !== waiting.id));
    assert.ok([...n.family, ...n.machine].every((i: { id: string }) => i.id !== waiting.id));
  });

  test('is never listed when it is a remote session, and its family comes marked with that machine', async () => {
    const theirs = (await get(remote, '/api/attention')).body.items as { session: string }[];
    const id = theirs[0]!.session;
    const r = await get(local, `/api/panel/${id}?needYou=all`);
    assert.equal(r.status, 200);
    assert.equal(r.body.machine.id, WS.id, 'the remote panel of #319');
    const n = r.body.needYou;
    assert.ok(n.items.every((i: { id: string }) => i.id !== id));
    assert.ok([...n.family, ...n.machine].every((i: { machine: { id: string } | null }) => i.machine?.id === WS.id));
    assert.ok(tunnel.paths.every((p) => !p.includes('needYou')));
    assert.equal(n.byMachine[1].n, theirs.filter((i) => i.session !== id && (i as unknown as { level: string }).level === 'needs').length);
    // Without the parameter, the remote panel of before.
    const plain = await get(local, `/api/panel/${id}`);
    assert.equal(plain.body.needYou.items, undefined);
  });
});
