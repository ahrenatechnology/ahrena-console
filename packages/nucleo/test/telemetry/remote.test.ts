// A remote machine (#176) read from a FAKE remote núcleo on loopback (fake-remote.ts): the requests
// it makes, each state and reason, the reading kept in SQLite while the remote is down, and the
// "Workstation sem conexão" alert on /api/changes. No external network; the 3 s deadline is
// shortened through the adapter's option, and the 30 s timer is a fake one.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { loopbackGet, REMOTE_HOST_HEADER, REMOTE_TIMEOUT_MS } from '../../src/telemetry/adapters/loopback-http.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { SAMPLE_INTERVAL_MS, TELEMETRY_VERSION, type Alert } from '../../src/telemetry/model.ts';
import type { RemoteGet } from '../../src/telemetry/ports.ts';
import { englishAttentionBody, publishRemoteAttentionChanges, RemoteMachine, type RemoteMachineOptions } from '../../src/telemetry/remote.ts';
import { publishAlertChanges } from '../../src/telemetry/sampler.ts';
import { TelemetryService } from '../../src/telemetry/service.ts';
import { attentionBody, closedPort, oldAttentionBody, oldRemoteItem, remoteItem, startFakeRemote, startMuteServer, type FakeRemote } from './fake-remote.ts';
import { reading, T0 } from './reading.ts';

/** Short, and only for the servers that never answer or close at once, so they do not wait 3 s. */
const MUTE_TIMEOUT_MS = 150;
/** For the reads that must succeed: generous, so a loaded runner never turns them into no-response. */
const READ_TIMEOUT_MS = 2_000;

const remoteReading = (at = T0) => reading({ host: { hostname: 'ws-exemplo', platform: 'linux', os: 'Ubuntu 24.04 LTS', arch: 'x64', uptimeSec: 7200 } }, at);
const volumeAlert: Alert = { id: 'volume-full:/', kind: 'volume-full', level: 'warning', message: 'O volume / passou de 85%', detail: null, since: '2026-11-02T11:00:00.000Z' };

let storage: SqliteStorage;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  storage?.close();
});

function setup(port: number, over: Partial<RemoteMachineOptions> = {}) {
  storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
  const logs: string[] = [];
  const remote = new RemoteMachine({
    config: { id: 'ws-exemplo', label: 'Workstation', port },
    get: loopbackGet({ timeoutMs: READ_TIMEOUT_MS }),
    store,
    tracker,
    onAlertChange: publishAlertChanges(cursor),
    onAttentionChange: publishRemoteAttentionChanges(cursor),
    now: () => T0,
    log: (m) => logs.push(m),
    ...over,
  });
  const service = new TelemetryService({ store, tracker, machines: [remote], now: () => T0 });
  return { remote, store, tracker, cursor, service, logs };
}

async function fake(state: Parameters<typeof startFakeRemote>[0] = {}, port = 0): Promise<FakeRemote> {
  const f = await startFakeRemote(state, port);
  cleanup.push(() => f.close());
  return f;
}

describe('#176/AC-2 how the remote núcleo is read', () => {
  test('#176/AC-2 GET /api/telemetry then /api/attention on 127.0.0.1:<port>, with Host 127.0.0.1:4720, no Origin, GET only', async () => {
    const f = await fake({ current: remoteReading() });
    const { remote } = setup(f.port);
    await remote.pollOnce();
    assert.deepEqual(f.requests, [
      { method: 'GET', url: '/api/telemetry', host: '127.0.0.1:4720', origin: undefined },
      { method: 'GET', url: '/api/attention', host: '127.0.0.1:4720', origin: undefined },
    ]);
    assert.equal(REMOTE_HOST_HEADER, '127.0.0.1:4720');
  });

  test('#176/AC-2 the deadline is 3 s by default and the poll runs every 30 s, once right away and without overlap', async () => {
    assert.equal(REMOTE_TIMEOUT_MS, 3_000);
    const f = await fake({ current: remoteReading() });
    let interval = 0;
    // Declared through `as`, so the assignment inside the fake timer is not narrowed away.
    let tick = null as (() => void) | null;
    const { remote } = setup(f.port, {
      timers: {
        setInterval: (fn, ms) => {
          interval = ms;
          tick = fn;
          return 1;
        },
        clearInterval: () => {
          tick = null;
        },
      },
    });
    remote.start();
    remote.start();
    assert.equal(interval, SAMPLE_INTERVAL_MS);
    assert.equal(SAMPLE_INTERVAL_MS, 30_000);
    tick!(); // still reading: skipped
    await remote.stop();
    assert.equal(f.requests.filter((r) => r.url === '/api/telemetry').length, 1);
    assert.equal(tick, null);
  });

  test('#176/AC-2 nothing on this Mac writes to the remote: every request of several polls is a GET', async () => {
    const f = await fake({ current: remoteReading(), attention: attentionBody([remoteItem('s1')]) });
    const { remote } = setup(f.port);
    for (let i = 0; i < 3; i++) await remote.pollOnce();
    assert.equal(f.requests.length, 6);
    assert.ok(f.requests.every((r) => r.method === 'GET'));
  });
});

describe('#176/AC-3 the remote state', () => {
  test('#176/AC-3 #176/AC-7 connected: the remote núcleo answers with the same telemetry version', async () => {
    const f = await fake({ current: remoteReading() });
    const { remote, service } = setup(f.port);
    assert.deepEqual(remote.status(), { state: 'unreachable', reason: null, version: null }, 'before the first read');
    assert.deepEqual(await remote.pollOnce(), { state: 'connected', reason: null, version: TELEMETRY_VERSION });
    assert.equal((await service.machines())[0]!.state, 'connected');
  });

  test('#176/AC-3 #176/AC-7 port closed: the local port refuses the connection (the tunnel is down)', async () => {
    const { remote, logs } = setup(await closedPort());
    assert.deepEqual(await remote.pollOnce(), { state: 'unreachable', reason: 'port-closed', version: null });
    assert.deepEqual(logs, ['telemetry (ws-exemplo): unreachable (port-closed)']);
  });

  test('#176/AC-3 #176/AC-7 open port without response: accepts and does not answer HTTP within the deadline', async () => {
    const mute = await startMuteServer('never');
    cleanup.push(() => mute.close());
    const { remote } = setup(mute.port, { get: loopbackGet({ timeoutMs: MUTE_TIMEOUT_MS }) });
    const started = Date.now();
    assert.deepEqual(await remote.pollOnce(), { state: 'unreachable', reason: 'no-response', version: null });
    assert.ok(Date.now() - started < 2_000, 'gave up at the injected deadline');
  });

  test('#176/AC-3 open port that closes at once is no-response too', async () => {
    const mute = await startMuteServer('at-once');
    cleanup.push(() => mute.close());
    const { remote } = setup(mute.port, { get: loopbackGet({ timeoutMs: MUTE_TIMEOUT_MS }) });
    assert.deepEqual(await remote.pollOnce(), { state: 'unreachable', reason: 'no-response', version: null });
  });

  test('#176/AC-3 different version: incompatible-version with the version the remote reports, nothing stored', async () => {
    const f = await fake({ version: TELEMETRY_VERSION + 1, current: remoteReading() });
    const { remote, store } = setup(f.port);
    assert.deepEqual(await remote.pollOnce(), { state: 'incompatible-version', reason: null, version: TELEMETRY_VERSION + 1 });
    assert.equal(await store.latest('ws-exemplo'), null);
    assert.equal(f.requests.length, 1, 'no attention read from a núcleo it does not understand');
  });

  test('#176/AC-3 a núcleo without the telemetry route (404) is incompatible-version with no version', async () => {
    const f = await fake({ noTelemetry: true });
    const { remote } = setup(f.port);
    assert.deepEqual(await remote.pollOnce(), { state: 'incompatible-version', reason: null, version: null });
  });

  test('#176/AC-3 a remote that refuses the Host (403) is no-response', async () => {
    const f = await fake({ current: remoteReading() });
    const get: RemoteGet = async (port, path) => {
      // A núcleo that wants another Host: what the fake does with a wrong one.
      const r = await loopbackGet({ timeoutMs: READ_TIMEOUT_MS })(port, path);
      return r.kind === 'response' ? { ...r, status: 403 } : r;
    };
    const { remote } = setup(f.port, { get });
    assert.deepEqual(await remote.pollOnce(), { state: 'unreachable', reason: 'no-response', version: null });
  });
});

describe('#176/AC-4 the last reading of a remote', () => {
  test('#176/AC-4 stored in telemetry_samples under the remote id, stamped with when this Mac read it, and served while the remote is down', async () => {
    const f = await fake({ current: remoteReading(T0 - 60_000) });
    const { remote, store, service } = setup(f.port);
    await remote.pollOnce();
    assert.equal(store.count('ws-exemplo'), 1);
    assert.equal(store.count('local'), 0);
    await f.close();
    cleanup.length = 0;
    assert.equal((await remote.pollOnce()).state, 'unreachable');
    const [summary] = await service.machines();
    assert.equal(summary!.lastReadAt, '2026-11-02T12:00:00.000Z');
    const t = await service.telemetry('ws-exemplo', 1);
    assert.equal(t?.current?.host.hostname, 'ws-exemplo');
    assert.equal(t?.current?.takenAt, '2026-11-02T12:00:00.000Z');
    assert.equal(t?.machine.state, 'unreachable');
    assert.equal(t?.series.at.length, 1);
  });

  test('#176/AC-4 the remote clock decides nothing: a reading dated 2099 neither prunes the older ones nor stays latest', async () => {
    const f = await fake({ current: remoteReading(Date.parse('2099-01-01T00:00:00.000Z')) });
    let now = T0;
    const { remote, store } = setup(f.port, { now: () => now });
    await remote.pollOnce();
    now = T0 + 30_000;
    await remote.pollOnce();
    assert.equal(store.count('ws-exemplo'), 2);
    assert.equal((await store.latest('ws-exemplo'))?.takenAt, '2026-11-02T12:00:30.000Z');
  });

  test('#176/AC-4 only the fields of a reading are kept, and a reading over the size cap is not stored', async () => {
    const extra = { ...remoteReading(), secret: 'x', host: { hostname: 'ws-exemplo', platform: 'linux', os: null, arch: 'x64', uptimeSec: 1, injected: 'y' } };
    const f = await fake({ current: extra as unknown as ReturnType<typeof remoteReading> });
    const { remote, store } = setup(f.port);
    await remote.pollOnce();
    const kept = (await store.latest('ws-exemplo')) as unknown as Record<string, unknown>;
    assert.equal('secret' in kept, false);
    assert.equal('injected' in (kept.host as object), false);
    f.state.current = { ...remoteReading(), ports: Array.from({ length: 5_000 }, (_, i) => ({ port: i, interface: 'loopback', address: null, process: 'p'.repeat(40), pid: i })) };
    await remote.pollOnce();
    assert.equal(store.count('ws-exemplo'), 1, 'the oversized one was dropped');
  });

  test('#176/AC-4 a reading without the shape a sample needs is not stored', async () => {
    const bad = { ...remoteReading(), cpu: { cores: 'many' } } as unknown as ReturnType<typeof remoteReading>;
    const f = await fake({ current: bad });
    const { remote, store } = setup(f.port);
    assert.equal((await remote.pollOnce()).state, 'connected');
    assert.equal(store.count('ws-exemplo'), 0);
  });
});

describe('#176/AC-5 a remote going down and coming back', () => {
  test('#176/AC-5 becomes the alert "Workstation sem conexão" and an alert change on /api/changes, both ways', async () => {
    const f = await fake({ current: remoteReading(), alerts: [volumeAlert] });
    const port = f.port;
    const { remote, tracker, cursor } = setup(port);
    await remote.pollOnce();
    assert.deepEqual(tracker.active('ws-exemplo').map((a) => a.id), ['volume-full:/'], "the remote's own alerts while connected");
    const start = cursor.current;

    await f.close();
    cleanup.length = 0;
    await remote.pollOnce();
    const [down] = tracker.active('ws-exemplo');
    assert.deepEqual(down, {
      id: 'machine-unreachable',
      kind: 'machine-unreachable',
      level: 'error',
      message: 'Workstation sem conexão',
      detail: `A porta ${port} deste Mac não aceita conexão: o túnel está caído`,
      since: '2026-11-02T12:00:00.000Z',
    });
    const wentDown = await cursor.wait(start, { timeoutMs: 0 });
    assert.deepEqual(wentDown.changes.map((m) => [m.type, m.key]).sort(), [
      ['alert', 'ws-exemplo:machine-unreachable'],
      ['alert', 'ws-exemplo:volume-full:/'],
    ]);

    await fake({ current: remoteReading(), alerts: [] }, port);
    await remote.pollOnce();
    assert.deepEqual(tracker.active('ws-exemplo'), []);
    const cameBack = await cursor.wait(wentDown.cursor, { timeoutMs: 0 });
    assert.deepEqual(cameBack.changes.map((m) => [m.type, m.key, m.sessionId]), [['alert', 'ws-exemplo:machine-unreachable', null]]);
  });

  test('#176/AC-5 the tunnel up and the núcleo down says so in the detail, with the label', async () => {
    const mute = await startMuteServer('at-once');
    cleanup.push(() => mute.close());
    const { remote, tracker } = setup(mute.port, { config: { id: 'ws-exemplo', label: 'Estação', port: mute.port }, get: loopbackGet({ timeoutMs: MUTE_TIMEOUT_MS }) });
    await remote.pollOnce();
    const [a] = tracker.active('ws-exemplo');
    assert.equal(a?.message, 'Estação sem conexão');
    assert.equal(a?.detail, `O túnel está de pé na porta ${mute.port}, mas o núcleo de lá não respondeu`);
  });
});

describe('#176/AC-5 the remote alerts are untrusted', () => {
  test('#176/AC-5 unknown kinds and a remote machine-unreachable are dropped, texts capped, at most 50', async () => {
    const many: Alert[] = Array.from({ length: 80 }, (_, i) => ({ ...volumeAlert, id: `volume-full:/v${i}`, message: 'm'.repeat(500) }));
    const f = await fake({ current: remoteReading(), alerts: [{ ...volumeAlert, kind: 'bogus' as Alert['kind'] }, { ...volumeAlert, id: 'machine-unreachable', kind: 'machine-unreachable' }, { ...volumeAlert, id: 'machine-unreachable' }, ...many] });
    const { remote, tracker } = setup(f.port);
    await remote.pollOnce();
    const active = tracker.active('ws-exemplo');
    assert.equal(active.length, 50);
    assert.ok(!active.some((a) => a.id === 'machine-unreachable'), 'a remote cannot open the id this Mac computes');
    assert.equal(active[0]!.id, 'volume-full:/v0');
    assert.ok(active.every((a) => a.kind === 'volume-full' && a.message.length === 200));
  });

  test('#176/AC-5 the reason changing (tunnel down, then núcleo down) publishes the alert again with the new detail', async () => {
    const closed = await closedPort();
    const mute = await startMuteServer('at-once');
    cleanup.push(() => mute.close());
    let port = closed;
    const base = loopbackGet({ timeoutMs: MUTE_TIMEOUT_MS });
    const { remote, cursor, tracker } = setup(closed, { get: (_p, path) => base(port, path) });
    await remote.pollOnce();
    const after = cursor.current;
    port = mute.port;
    await remote.pollOnce();
    const r = await cursor.wait(after, { timeoutMs: 0 });
    assert.deepEqual(r.changes.map((m) => [m.type, m.key]), [['alert', 'ws-exemplo:machine-unreachable']]);
    assert.match(tracker.active('ws-exemplo')[0]!.detail!, /núcleo de lá não respondeu/);
  });
});

describe('#176/AC-6 the remote sessions that need you', () => {
  test('#176/AC-6 kept while connected, dropped when the remote goes down, and each change published', async () => {
    const f = await fake({ current: remoteReading(), attention: attentionBody([remoteItem('s1')]) });
    const { remote, cursor } = setup(f.port);
    const start = cursor.current;
    await remote.pollOnce();
    assert.equal((remote.attention() as { items: unknown[] }).items.length, 1);
    const entered = await cursor.wait(start, { timeoutMs: 0 });
    assert.deepEqual(entered.changes.map((m) => [m.type, m.key, m.sessionId, m.accountId]), [['needs-you', 'ws-exemplo:s1', null, null]]);

    await f.close();
    cleanup.length = 0;
    await remote.pollOnce();
    assert.equal(remote.attention(), null);
    const left = await cursor.wait(entered.cursor, { timeoutMs: 0 });
    assert.ok(left.changes.some((m) => m.type === 'needs-you' && m.key === 'ws-exemplo:s1'));
  });
});

describe('#173 phase 2b: a remote núcleo from before the English keys', () => {
  test('its Portuguese attention answer is kept as the English one, and its changes are published', async () => {
    const f = await fake({ current: remoteReading(), attention: oldAttentionBody([oldRemoteItem('s1')], { ativas: 3, comErro: 1 }) });
    const { remote, cursor } = setup(f.port);
    const start = cursor.current;
    await remote.pollOnce();
    assert.deepEqual(remote.attention(), {
      active: 3,
      withError: 1,
      items: [
        {
          session: 's1',
          title: 'Sessão s1',
          project: 'projeto-exemplo',
          account: { label: 'equipe', color: '#3366ff' },
          level: 'needs',
          reason: 'permission',
          longReason: 'pede permissão para usar Bash',
          since: '2026-11-02T11:55:00.000Z',
          minutes: 5,
          local: 'local_00000000-0000-4000-8000-000000000009',
          machine: null,
        },
      ],
    });
    const entered = await cursor.wait(start, { timeoutMs: 0 });
    assert.deepEqual(entered.changes.map((m) => [m.type, m.key]), [['needs-you', 'ws-exemplo:s1']]);
  });

  test('every old level and reason reads as the new one; an English body and unknown values pass untouched', () => {
    const levels = { precisa: 'needs', 'sua-vez': 'your-turn' };
    const reasons = { permissao: 'permission', pergunta: 'question', plano: 'plan', decisao: 'decision', erro: 'error', 'sua-vez': 'your-turn', interrompida: 'interrupted', 'no-prompt': 'no-prompt', outro: 'outro' };
    for (const [old, now] of Object.entries(levels)) {
      const r = englishAttentionBody(oldAttentionBody([oldRemoteItem('s', { nivel: old })])) as { items: { level: string }[] };
      assert.equal(r.items[0]!.level, now, old);
    }
    for (const [old, now] of Object.entries(reasons)) {
      const r = englishAttentionBody(oldAttentionBody([oldRemoteItem('s', { motivo: old })])) as { items: { reason: string }[] };
      assert.equal(r.items[0]!.reason, now, old);
    }
    const english = attentionBody([remoteItem('s1')]);
    assert.equal(englishAttentionBody(english), english);
    const oldNoAccount = englishAttentionBody(oldAttentionBody([oldRemoteItem('s', { conta: null }), 'not an item'])) as { items: unknown[] };
    assert.equal((oldNoAccount.items[0] as { account: unknown }).account, null);
    assert.equal(oldNoAccount.items[1], 'not an item');
  });
});
