// GET /api/machines and GET /api/telemetry (#175) on 127.0.0.1, over in-memory SQLite with the
// simulator's synthetic telemetry: the shape of both responses, the 1 h and 12 h windows, the 400 and
// 404 of each parameter, the núcleo without telemetry, the Origin and Host defenses (decision 0003),
// an alert that enters arriving through /api/changes, and the simulator (this machine and the "workstation").
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { SIMULATED_WORKSTATION, seedTelemetry, SimulatedCollector, simulatedReading } from '../../src/simulator/telemetry.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { MACHINE_STATES } from '../../src/telemetry/model.ts';
import { publishAlertChanges, TelemetrySampler } from '../../src/telemetry/sampler.ts';
import { localMachine, TelemetryService, type TelemetryResponse } from '../../src/telemetry/service.ts';
import { ScriptedCollector } from '../telemetry/doubles.ts';
import { reading } from '../telemetry/reading.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

async function boot(opts: { withTelemetry?: boolean } = {}) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
  await seedTelemetry(store, 'local', 'local', NOW);
  await seedTelemetry(store, SIMULATED_WORKSTATION.id, 'workstation', NOW);
  const machines = [localMachine(), { ...SIMULATED_WORKSTATION, state: () => 'connected' as const }];
  for (const m of machines) {
    // The sampler's first sample computes the open alerts over what was seeded.
    await new TelemetrySampler({ machineId: m.id, collector: new SimulatedCollector(m.id === 'local' ? 'local' : 'workstation', () => NOW), store, tracker }).sampleOnce();
  }
  const telemetry = opts.withTelemetry === false ? undefined : new TelemetryService({ store, tracker, machines, now: () => NOW });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, changes: cursor, telemetry });
  return {
    api,
    store,
    tracker,
    cursor,
    get: (path: string, headers: Record<string, string> = {}) => fetch(`${api.url}${path}`, { headers }),
    close: async () => {
      await api.close();
      await storage.close();
    },
  };
}

/** A request with whatever Host is wanted (fetch does not let the Host be changed). */
function withHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', reject);
    r.end();
  });
}

describe('#175/AC-4 GET /api/machines', () => {
  test('this machine first, then the synthetic workstation, each with state, last reading and alerts', async () => {
    const { get, close } = await boot();
    try {
      const r = await get('/api/machines');
      assert.equal(r.status, 200);
      const body = (await r.json()) as unknown[];
      assert.deepEqual(body, [
        { id: 'local', label: 'Esta máquina', state: 'connected', reason: null, version: 1, port: null, lastReadAt: '2026-11-02T12:00:00.000Z', alerts: 2 },
        { id: 'workstation', label: 'Workstation', state: 'connected', reason: null, version: 1, port: 14720, lastReadAt: '2026-11-02T12:00:00.000Z', alerts: 3 },
      ]);
      assert.deepEqual([...MACHINE_STATES], ['connected', 'unreachable', 'not-configured', 'incompatible-version']);
    } finally {
      await close();
    }
  });
});

describe('#175/AC-5 GET /api/telemetry', () => {
  test('default: local, 1 h; the version, the current reading with English keys, the series and the alerts', async () => {
    const { get, close } = await boot();
    try {
      const r = await get('/api/telemetry');
      assert.equal(r.status, 200);
      const t = (await r.json()) as TelemetryResponse;
      assert.deepEqual(Object.keys(t).sort(), ['alerts', 'current', 'hours', 'machine', 'series', 'version']);
      assert.equal(t.version, 1);
      assert.equal(t.hours, 1);
      assert.equal(t.machine.id, 'local');
      const c = t.current!;
      assert.deepEqual(Object.keys(c).sort(), ['claude', 'cpu', 'disk', 'docker', 'gpu', 'host', 'memory', 'network', 'ports', 'takenAt', 'topProcesses', 'tunnels']);
      assert.equal(typeof c.cpu.usedPct, 'number');
      assert.deepEqual(Object.keys(c.cpu.load), ['one', 'five', 'fifteen']);
      assert.equal(typeof c.memory.usedBytes, 'number');
      assert.equal(typeof c.memory.swapUsedBytes, 'number');
      assert.ok(Array.isArray(c.disk.volumes));
      assert.equal(c.claude?.processes.count, 11);
      assert.deepEqual(c.tunnels?.[0].ports.map((p) => p.state), ['up', 'up', 'idle', 'busy']);
      assert.equal(t.series.at.length, 120);
      assert.equal(t.series.cpuUsedPct.length, 120);
      assert.deepEqual(t.alerts.map((a) => [a.id, a.level, a.message]), [
        ['port-exposed:5432', 'warning', 'A porta 5432 escuta em todas as interfaces'],
        ['tunnel-busy:18080', 'warning', 'A porta 18080 do túnel está ocupada'],
      ]);
    } finally {
      await close();
    }
  });

  test('12 h in buckets, and the workstation with Docker, GPU and the full volume', async () => {
    const { get, close } = await boot();
    try {
      const t = (await (await get('/api/telemetry?machine=workstation&hours=12')).json()) as TelemetryResponse;
      assert.equal(t.hours, 12);
      assert.ok(t.series.at.length > 120 && t.series.at.length <= 360, `${t.series.at.length}`);
      assert.equal(t.current?.cpu.cores, 16);
      assert.equal(t.current?.docker?.stacks.length, 4);
      assert.equal(t.current?.gpu?.name, 'GPU Exemplo T4');
      assert.equal(t.current?.tunnels, null);
      assert.ok(t.alerts.some((a) => a.id === 'volume-full:/' && a.message === 'O volume / passou de 85%'));
    } finally {
      await close();
    }
  });

  test('invalid parameter gives 400; a machine that does not exist, 404; without telemetry, 404 on both', async () => {
    const { get, close } = await boot();
    try {
      // Empty means the default, as if absent.
      const empty = await get('/api/telemetry?hours=');
      assert.equal(empty.status, 200);
      assert.equal(((await empty.json()) as TelemetryResponse).hours, 1);
      for (const q of ['?hours=2', '?hours=abc', '?hours=1.0', '?hours=-1', '?hours=012', '?machine=Local', '?machine=../x', `?machine=${'a'.repeat(65)}`]) {
        const r = await get(`/api/telemetry${q}`);
        assert.equal(r.status, 400, q);
        assert.equal(typeof ((await r.json()) as { error: string }).error, 'string');
      }
      const r = await get('/api/telemetry?machine=outra');
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'máquina desconhecida: outra' });
    } finally {
      await close();
    }
    const without = await boot({ withTelemetry: false });
    try {
      assert.equal((await without.get('/api/machines')).status, 404);
      assert.equal((await without.get('/api/telemetry')).status, 404);
    } finally {
      await without.close();
    }
  });

  test('GET only, and the 0003 defenses: a foreign Origin and a strange Host give 403; the own /ui can read', async () => {
    const { api, get, close } = await boot();
    try {
      const host = new URL(api.url).host;
      assert.equal((await fetch(`${api.url}/api/machines`, { method: 'POST' })).status, 405);
      assert.equal((await get('/api/machines', { origin: 'http://outro.example' })).status, 403);
      assert.equal((await get('/api/telemetry', { origin: `http://${host}` })).status, 200);
      assert.equal(await withHost(`${api.url}/api/machines`, 'outro.example:4720'), 403);
    } finally {
      await close();
    }
  });
});

describe('#175/AC-3 o alerta chega por /api/changes', () => {
  test('the sample that opens an alert wakes whoever waits on `type=alert`', async () => {
    const { get, store, tracker, cursor, close } = await boot();
    try {
      const start = (await (await get('/api/changes?wait=0')).json()) as { cursor: string };
      const pending = get(`/api/changes?since=${start.cursor}&wait=5&type=alert`);
      const exposed = reading({ ports: [{ port: 6379, interface: 'all', address: null, process: 'redis-server', pid: 9 }] }, NOW + 30_000);
      await new TelemetrySampler({ machineId: 'local', collector: new ScriptedCollector([exposed]), store, tracker, onAlertChange: publishAlertChanges(cursor) }).sampleOnce();
      const r = (await (await pending).json()) as { changes: { type: string; key: string }[] };
      assert.ok(r.changes.some((m) => m.type === 'alert' && m.key === 'local:port-exposed:6379'), JSON.stringify(r.changes));
    } finally {
      await close();
    }
  });
});

describe('#175/AC-6 simulador', () => {
  test('12 h seeded, one sample every 30 s, pruning keeps the window', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    try {
      const store = new SqliteTelemetryStore(storage.db);
      assert.equal(await seedTelemetry(store, 'local', 'local', NOW), 1440);
      await seedTelemetry(store, 'local', 'local', NOW + 3_600_000, 1);
      assert.equal(store.count('local'), 1440);
    } finally {
      await storage.close();
    }
  });

  test('the same hour gives the same reading; the workstation load goes above the cores and back', async () => {
    assert.deepEqual(simulatedReading('workstation', NOW), simulatedReading('workstation', NOW));
    const tracker = new AlertTracker();
    const storage = openSqliteStorage({ path: ':memory:' });
    try {
      const store = new SqliteTelemetryStore(storage.db);
      let t = NOW;
      const s = new TelemetrySampler({ machineId: 'workstation', collector: new SimulatedCollector('workstation', () => t), store, tracker });
      const transitions: string[] = [];
      let before = false;
      for (let i = 0; i < 2 * 120; i++, t += 30_000) {
        await s.sampleOnce();
        const now = tracker.active('workstation').some((a) => a.id === 'load-high');
        if (now !== before) transitions.push(now ? 'entrou' : 'saiu');
        before = now;
      }
      assert.ok(transitions.includes('entrou') && transitions.includes('saiu'), transitions.join());
    } finally {
      await storage.close();
    }
  });
});
