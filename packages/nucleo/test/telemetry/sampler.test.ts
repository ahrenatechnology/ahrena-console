// The sampler and the routes' reading (#175/AC-2, AC-3, AC-4), over port doubles: a sample at
// each interval, with no overlap, the pruning, the alerts published on the changes cursor and the shape
// of the machine list.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CursorDeMudancas } from '../../src/mudancas/cursor.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { publishAlertChanges, TelemetrySampler, type SamplerTimers } from '../../src/telemetry/sampler.ts';
import { localMachine, TelemetryService } from '../../src/telemetry/service.ts';
import { MemoryTelemetryStore, ScriptedCollector } from './doubles.ts';
import { reading, T0 } from './reading.ts';

const exposed = (at: number) => reading({ ports: [{ port: 5432, interface: 'all', address: null, process: 'postgres', pid: 7 }] }, at);

function fakeTimers() {
  const fns: (() => void)[] = [];
  let cleared = 0;
  const timers: SamplerTimers = {
    setInterval: (fn) => (fns.push(fn), fns.length),
    clearInterval: () => void cleared++,
  };
  return { timers, fire: () => fns.forEach((f) => f()), get count() { return fns.length; }, get cleared() { return cleared; } };
}

describe('#175/AC-2 sampler', () => {
  test('reads at once, then every interval; start twice does not set another timer; stop stops', async () => {
    const store = new MemoryTelemetryStore();
    const collector = new ScriptedCollector([reading({}, T0), reading({}, T0 + 30_000)]);
    const t = fakeTimers();
    const s = new TelemetrySampler({ machineId: 'local', collector, store, tracker: new AlertTracker(), timers: t.timers });
    s.start();
    s.start();
    assert.equal(t.count, 1);
    await s.stop();
    assert.equal(collector.calls, 1);
    assert.equal(t.cleared, 1);
    assert.equal(s.running, false);
    assert.equal((await store.latest('local'))?.takenAt, reading({}, T0).takenAt);
  });

  test('no overlap: a tick during a slow reading is skipped', async () => {
    let release!: () => void;
    const slow = { calls: 0, collect: () => (slow.calls++, new Promise<ReturnType<typeof reading>>((r) => (release = () => r(reading()))) ) };
    const t = fakeTimers();
    const s = new TelemetrySampler({ machineId: 'local', collector: slow, store: new MemoryTelemetryStore(), tracker: new AlertTracker(), timers: t.timers });
    s.start();
    t.fire();
    t.fire();
    assert.equal(slow.calls, 1);
    release();
    await s.stop();
  });

  test('the 12 h pruning on write, by the store', async () => {
    const store = new MemoryTelemetryStore();
    const H = 3_600_000;
    const collector = new ScriptedCollector([reading({}, T0 - 13 * H), reading({}, T0 - 11 * H), reading({}, T0)]);
    const s = new TelemetrySampler({ machineId: 'local', collector, store, tracker: new AlertTracker() });
    for (let i = 0; i < 3; i++) await s.sampleOnce();
    assert.equal(store.rows.get('local')?.length, 2);
  });

  test('a reading that fails goes to the log and does not stop the sampler', async () => {
    const logs: string[] = [];
    const s = new TelemetrySampler({ machineId: 'local', collector: new ScriptedCollector([new Error('ps sumiu')]), store: new MemoryTelemetryStore(), tracker: new AlertTracker(), log: (m) => logs.push(m) });
    assert.equal(await s.sampleOnce(), null);
    assert.deepEqual(logs, ['telemetry (local): ps sumiu']);
  });
});

describe('#175/AC-3 alerts on /api/changes', () => {
  test('an alert entering and exiting become `alert` changes, once each', async () => {
    const cursor = new CursorDeMudancas({ geracao: 'g1', intervaloMinimoMs: 0, agruparMs: 0 });
    const start = cursor.atual;
    const collector = new ScriptedCollector([exposed(T0), exposed(T0 + 30_000), reading({}, T0 + 60_000)]);
    const s = new TelemetrySampler({ machineId: 'local', collector, store: new MemoryTelemetryStore(), tracker: new AlertTracker(), onAlertChange: publishAlertChanges(cursor) });
    await s.sampleOnce();
    const r1 = await cursor.aguardar(start, { timeoutMs: 0 });
    assert.deepEqual(r1.changes.map((m) => [m.type, m.key, m.sessionId, m.accountId]), [['alert', 'local:port-exposed:5432', null, null]]);
    await s.sampleOnce(); // continues: nothing new
    assert.equal((await cursor.aguardar(r1.cursor, { timeoutMs: 0 })).changes.length, 0);
    await s.sampleOnce(); // exited
    const r3 = await cursor.aguardar(r1.cursor, { timeoutMs: 0 });
    assert.deepEqual(r3.changes.map((m) => m.key), ['local:port-exposed:5432']);
    assert.deepEqual((await cursor.aguardar(r1.cursor, { timeoutMs: 0, filtros: { tipos: ['alert'] } })).changes.length, 1);
  });

  test('load above the cores for 5 min, over the recorded samples', async () => {
    const high = (i: number) => reading({ cpu: { cores: 4, model: null, usedPct: 100, load: { one: 9, five: 7, fifteen: 5 } } }, T0 + i * 30_000);
    const collector = new ScriptedCollector(Array.from({ length: 11 }, (_, i) => high(i)));
    const tracker = new AlertTracker();
    const s = new TelemetrySampler({ machineId: 'local', collector, store: new MemoryTelemetryStore(), tracker });
    for (let i = 0; i < 10; i++) await s.sampleOnce();
    assert.deepEqual(tracker.active('local'), []);
    await s.sampleOnce();
    assert.deepEqual(tracker.active('local').map((a) => a.id), ['load-high']);
  });
});

describe('#175/AC-4 and AC-5 the routes reading', () => {
  test('machines: local connected, the time of the last reading and the number of alerts', async () => {
    const store = new MemoryTelemetryStore();
    const tracker = new AlertTracker();
    const service = new TelemetryService({ store, tracker, machines: [localMachine()], now: () => T0 });
    assert.deepEqual(await service.machines(), [{ id: 'local', label: 'Esta máquina', state: 'connected', lastReadAt: null, alerts: 0 }]);
    await new TelemetrySampler({ machineId: 'local', collector: new ScriptedCollector([exposed(T0)]), store, tracker }).sampleOnce();
    assert.deepEqual(await service.machines(), [{ id: 'local', label: 'Esta máquina', state: 'connected', lastReadAt: '2026-11-02T12:00:00.000Z', alerts: 1 }]);
  });

  test('telemetry: version, current reading, window series and alerts; an unknown machine is null', async () => {
    const store = new MemoryTelemetryStore();
    const tracker = new AlertTracker();
    const s = new TelemetrySampler({ machineId: 'local', collector: new ScriptedCollector([exposed(T0 - 2 * 3_600_000), exposed(T0 - 60_000), exposed(T0)]), store, tracker });
    for (let i = 0; i < 3; i++) await s.sampleOnce();
    const service = new TelemetryService({ store, tracker, machines: [localMachine()], now: () => T0 });
    const t = await service.telemetry('local', 1);
    assert.ok(t);
    assert.equal(t.version, 1);
    assert.equal(t.hours, 1);
    assert.equal(t.current?.takenAt, '2026-11-02T12:00:00.000Z');
    assert.equal(t.series.at.length, 2);
    assert.equal((await service.telemetry('local', 12))?.series.at.length, 3);
    assert.deepEqual(t.alerts.map((a) => a.id), ['port-exposed:5432']);
    assert.equal(await service.telemetry('workstation', 1), null);
  });
});
