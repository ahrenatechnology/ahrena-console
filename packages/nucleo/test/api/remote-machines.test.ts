// The remote machines (#176) through this Mac's own API on 127.0.0.1: `GET /api/machines` with one
// remote, `GET /api/telemetry?machine=<id>` while the remote is down, and the remote sessions in
// `GET /api/attention`. The remote is a FAKE núcleo on loopback (test/telemetry/fake-remote.ts); the
// sessions of this machine are the MCP tests' synthetic ones. No external network, no real machine.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, startLocalApi, montarAtencao, MontadorDoPainel, remoteAttentionItems, type LocalApi, type RespostaDaAtencao } from '../../src/api/index.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { RemoteMachine } from '../../src/telemetry/remote.ts';
import { publishAlertChanges } from '../../src/telemetry/sampler.ts';
import { localMachine, TelemetryService, type TelemetryResponse } from '../../src/telemetry/service.ts';
import { NOW, seed } from '../mcp/helpers.ts';
import { attentionBody, remoteItem, startFakeRemote, type FakeRemote } from '../telemetry/fake-remote.ts';
import { reading } from '../telemetry/reading.ts';

/** The remote's own clock; the stored reading carries when this Mac read it (NOW). */
const READ_AT = NOW - 30_000;
const READ_AT_ISO = new Date(NOW).toISOString();

let storage: SqliteStorage;
let api: LocalApi | null = null;
let remoteCore: FakeRemote | null = null;
afterEach(async () => {
  await api?.close();
  await remoteCore?.close();
  api = null;
  remoteCore = null;
  await storage.close();
});

async function boot() {
  storage = openSqliteStorage({ path: ':memory:' });
  await seed(storage);
  const contas = new Contas({ storage, arquivo: null });
  const frota = new FleetReader({ storage, accounts: contas, now: () => NOW, timeZone: 'UTC' });
  const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  remoteCore = await startFakeRemote({
    current: reading({ host: { hostname: 'ws-exemplo', platform: 'linux', os: 'Ubuntu 24.04 LTS', arch: 'x64', uptimeSec: 7200 } }, READ_AT),
    attention: attentionBody(
      [
        remoteItem('remota-1'),
        remoteItem('remota-2', { level: 'your-turn', reason: 'your-turn', shortReason: 'Sua vez', since: '2026-11-02T11:00:00.000Z' }),
        // A remote's own remote is not passed on, nor is an item without the shape.
        remoteItem('de-outra', { machine: { id: 'outra', label: 'Outra' } }),
        { session: 'sem-forma' },
      ],
      { active: 2, withError: 1 },
    ),
  });
  const remote = new RemoteMachine({
    config: { id: 'ws-exemplo', label: 'Workstation', port: remoteCore.port },
    get: loopbackGet({ timeoutMs: 2_000 }),
    store,
    tracker,
    onAlertChange: publishAlertChanges(cursor),
    now: () => NOW,
  });
  const telemetry = new TelemetryService({ store, tracker, machines: [localMachine(), remote], now: () => NOW });
  const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
  api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, changes: cursor, telemetry, fleet: frota, remoteAttention: [remote] });
  const url = api.url;
  return { remote, frota, get: (path: string) => fetch(`${url}${path}`) };
}

describe('#176/AC-3 GET /api/machines with one remote', () => {
  test('#176/AC-3 each remote with state, reason, version, port, the age of its last reading and its alerts', async () => {
    const { remote, get } = await boot();
    await remote.pollOnce();
    const r = await get('/api/machines');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), [
      { id: 'local', label: 'Esta máquina', state: 'connected', reason: null, version: 1, port: null, lastReadAt: null, alerts: 0 },
      { id: 'ws-exemplo', label: 'Workstation', state: 'connected', reason: null, version: 1, port: remoteCore!.port, lastReadAt: READ_AT_ISO, alerts: 0 },
    ]);

    const port = remoteCore!.port;
    await remoteCore!.close();
    remoteCore = null;
    await remote.pollOnce();
    assert.deepEqual(((await (await get('/api/machines')).json()) as unknown[])[1], {
      id: 'ws-exemplo',
      label: 'Workstation',
      state: 'unreachable',
      reason: 'port-closed',
      version: null,
      port,
      lastReadAt: READ_AT_ISO,
      alerts: 1,
    });
  });
});

describe('#176/AC-4 GET /api/telemetry?machine=<remote>', () => {
  test('#176/AC-4 returns the last reading even with the remote down, with the "sem conexão" alert', async () => {
    const { remote, get } = await boot();
    await remote.pollOnce();
    await remoteCore!.close();
    remoteCore = null;
    await remote.pollOnce();
    const r = await get('/api/telemetry?machine=ws-exemplo');
    assert.equal(r.status, 200);
    const t = (await r.json()) as TelemetryResponse;
    assert.equal(t.machine.state, 'unreachable');
    assert.equal(t.machine.lastReadAt, READ_AT_ISO);
    assert.equal(t.current?.host.hostname, 'ws-exemplo');
    assert.deepEqual(t.alerts.map((a) => a.message), ['Workstation sem conexão']);
  });
});

describe('#176/AC-6 the remote sessions in the attention response', () => {
  test('#176/AC-6 enter GET /api/attention with machine { id, label } and local null, sorted with this machine\'s', async () => {
    const { remote, get } = await boot();
    await remote.pollOnce();
    const r = (await (await get('/api/attention')).json()) as RespostaDaAtencao;
    const remotes = r.items.filter((i) => i.machine);
    assert.deepEqual(
      remotes.map((i) => [i.session, i.machine, i.local, i.level]),
      [
        ['remota-1', { id: 'ws-exemplo', label: 'Workstation' }, null, 'needs'],
        ['remota-2', { id: 'ws-exemplo', label: 'Workstation' }, null, 'your-turn'],
      ],
    );
    // This machine's sessions are marked with no machine and keep their Desktop id.
    assert.ok(r.items.filter((i) => !i.machine).every((i) => i.machine === null));
    assert.equal(r.total, 9);
    assert.equal(r.needs, 5);
    assert.equal(r.yourTurn, 4);
    // Urgent first: the remote permission comes before every "sua vez", the remote one included.
    const order = r.items.map((i) => i.session);
    assert.ok(order.indexOf('remota-1') < order.indexOf('erro'));
    assert.ok(order.indexOf('remota-2') > order.indexOf('erro'));
    // The remote's active and errored sessions add to this machine's (2 active, 1 with error).
    assert.equal(r.active, 4);
    assert.equal(r.withError, 2);
  });

  test('#176/AC-6 a remote that is down contributes no session', async () => {
    const { remote, frota } = await boot();
    await remote.pollOnce();
    await remoteCore!.close();
    remoteCore = null;
    await remote.pollOnce();
    const r = await montarAtencao(frota, null, [remote]);
    assert.equal(r.items.filter((i) => i.machine).length, 0);
    assert.equal(r.total, 7);
  });
});

describe('#176/AC-6 remote attention items are untrusted', () => {
  test('#176/AC-6 an item whose reason is not a string or whose minutes is not finite is left out', () => {
    const machine = { id: 'ws-exemplo', label: 'Workstation' };
    const body = attentionBody([remoteItem('ok'), remoteItem('array', { reason: ['error'] }), remoteItem('infinito', { minutes: Infinity })]);
    assert.deepEqual(remoteAttentionItems(body, machine).map((i) => i.session), ['ok']);
  });

  test('#176/AC-6 an account color that is not #rrggbb is not passed through', () => {
    const machine = { id: 'ws-exemplo', label: 'Workstation' };
    const body = attentionBody([remoteItem('hex'), remoteItem('url', { account: { label: 'equipe', color: 'url(//x.y/a)' } })]);
    const [hex, url] = remoteAttentionItems(body, machine);
    assert.equal(hex.account?.color, '#3366ff');
    assert.match(url.account?.color ?? '', /^#[0-9a-f]{6}$/i);
    assert.notEqual(url.account?.color, 'url(//x.y/a)');
  });

  test('#176/AC-6 an item whose since is not a date or whose minutes is negative is left out', () => {
    const machine = { id: 'ws-exemplo', label: 'Workstation' };
    const body = attentionBody([remoteItem('ok'), remoteItem('sem-data', { since: 'not a date' }), remoteItem('negativo', { minutes: -5 })]);
    assert.deepEqual(remoteAttentionItems(body, machine).map((i) => i.session), ['ok']);
  });

  test('#176/AC-6 a remote adds at most 10000 to active and to withError', async () => {
    const { frota } = await boot();
    const local = await montarAtencao(frota, null, []);
    const huge = { id: 'ws-exemplo', label: 'Workstation', attention: () => attentionBody([], { active: 1e15, withError: 1e15 }) };
    const r = await montarAtencao(frota, null, [huge]);
    assert.equal(r.active, local.active + 10_000);
    assert.equal(r.withError, local.withError + 10_000);
  });
});
