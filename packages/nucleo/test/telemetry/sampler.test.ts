// O amostrador e a leitura das rotas (#175/AC-2, AC-3, AC-4), sobre dublês das portas: a amostra a
// cada intervalo, sem sobreposição, a poda, os alertas publicados no cursor de mudanças e a forma
// da lista de máquinas.
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

describe('#175/AC-2 amostrador', () => {
  test('lê na hora, depois a cada intervalo; start duas vezes não liga outro timer; stop para', async () => {
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

  test('sem sobreposição: o tique durante uma leitura lenta é pulado', async () => {
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

  test('a poda de 12 h na escrita, pelo armazenamento', async () => {
    const store = new MemoryTelemetryStore();
    const H = 3_600_000;
    const collector = new ScriptedCollector([reading({}, T0 - 13 * H), reading({}, T0 - 11 * H), reading({}, T0)]);
    const s = new TelemetrySampler({ machineId: 'local', collector, store, tracker: new AlertTracker() });
    for (let i = 0; i < 3; i++) await s.sampleOnce();
    assert.equal(store.rows.get('local')?.length, 2);
  });

  test('leitura que falha vai para o log e não para o amostrador', async () => {
    const logs: string[] = [];
    const s = new TelemetrySampler({ machineId: 'local', collector: new ScriptedCollector([new Error('ps sumiu')]), store: new MemoryTelemetryStore(), tracker: new AlertTracker(), log: (m) => logs.push(m) });
    assert.equal(await s.sampleOnce(), null);
    assert.deepEqual(logs, ['telemetria (local): ps sumiu']);
  });
});

describe('#175/AC-3 alertas em /api/changes', () => {
  test('a entrada e a saída de um alerta viram mudanças `alert`, uma vez cada', async () => {
    const cursor = new CursorDeMudancas({ geracao: 'g1', intervaloMinimoMs: 0, agruparMs: 0 });
    const start = cursor.atual;
    const collector = new ScriptedCollector([exposed(T0), exposed(T0 + 30_000), reading({}, T0 + 60_000)]);
    const s = new TelemetrySampler({ machineId: 'local', collector, store: new MemoryTelemetryStore(), tracker: new AlertTracker(), onAlertChange: publishAlertChanges(cursor) });
    await s.sampleOnce();
    const r1 = await cursor.aguardar(start, { timeoutMs: 0 });
    assert.deepEqual(r1.mudancas.map((m) => [m.tipo, m.chave, m.sessionId, m.accountId]), [['alert', 'local:port-exposed:5432', null, null]]);
    await s.sampleOnce(); // continua: nada novo
    assert.equal((await cursor.aguardar(r1.cursor, { timeoutMs: 0 })).mudancas.length, 0);
    await s.sampleOnce(); // saiu
    const r3 = await cursor.aguardar(r1.cursor, { timeoutMs: 0 });
    assert.deepEqual(r3.mudancas.map((m) => m.chave), ['local:port-exposed:5432']);
    assert.deepEqual((await cursor.aguardar(r1.cursor, { timeoutMs: 0, filtros: { tipos: ['alert'] } })).mudancas.length, 1);
  });

  test('carga acima dos núcleos por 5 min, sobre as amostras gravadas', async () => {
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

describe('#175/AC-4 e AC-5 a leitura das rotas', () => {
  test('máquinas: local conectada, a hora da última leitura e o número de alertas', async () => {
    const store = new MemoryTelemetryStore();
    const tracker = new AlertTracker();
    const service = new TelemetryService({ store, tracker, machines: [localMachine()], now: () => T0 });
    assert.deepEqual(await service.machines(), [{ id: 'local', label: 'Esta máquina', state: 'connected', lastReadAt: null, alerts: 0 }]);
    await new TelemetrySampler({ machineId: 'local', collector: new ScriptedCollector([exposed(T0)]), store, tracker }).sampleOnce();
    assert.deepEqual(await service.machines(), [{ id: 'local', label: 'Esta máquina', state: 'connected', lastReadAt: '2026-11-02T12:00:00.000Z', alerts: 1 }]);
  });

  test('telemetria: versão, leitura atual, série da janela e alertas; máquina desconhecida é null', async () => {
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
