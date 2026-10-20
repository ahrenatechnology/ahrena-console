// GET /api/machines e GET /api/telemetry (#175) em 127.0.0.1, sobre o SQLite em memória com a
// telemetria sintética do simulador: a forma das duas respostas, a janela de 1 h e de 12 h, o 400 e o
// 404 de cada parâmetro, o núcleo sem telemetria, as defesas de Origin e Host (decisão 0003), o
// alerta que entra chegando por /api/changes, e o simulador (esta máquina e a "workstation").
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, MontadorDoPainel, iniciarApiLocal } from '../../src/api/index.ts';
import { CursorDeMudancas } from '../../src/mudancas/cursor.ts';
import { SIMULATED_WORKSTATION, seedTelemetry, SimulatedCollector, simulatedReading } from '../../src/simulador/telemetry.ts';
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
  const cursor = new CursorDeMudancas({ geracao: 'g1', intervaloMinimoMs: 0, agruparMs: 0 });
  await seedTelemetry(store, 'local', 'local', NOW);
  await seedTelemetry(store, SIMULATED_WORKSTATION.id, 'workstation', NOW);
  const machines = [localMachine(), { ...SIMULATED_WORKSTATION, state: () => 'connected' as const }];
  for (const m of machines) {
    // A primeira amostra do amostrador calcula os alertas abertos sobre o que foi semeado.
    await new TelemetrySampler({ machineId: m.id, collector: new SimulatedCollector(m.id === 'local' ? 'local' : 'workstation', () => NOW), store, tracker }).sampleOnce();
  }
  const telemetry = opts.withTelemetry === false ? undefined : new TelemetryService({ store, tracker, machines, now: () => NOW });
  const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null });
  const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, mudancas: cursor, telemetry });
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

/** Pedido com o Host que se quiser (o fetch não deixa trocar o Host). */
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
  test('esta máquina primeiro, a workstation sintética, cada uma com estado, última leitura e alertas', async () => {
    const { get, close } = await boot();
    try {
      const r = await get('/api/machines');
      assert.equal(r.status, 200);
      const body = (await r.json()) as unknown[];
      assert.deepEqual(body, [
        { id: 'local', label: 'Esta máquina', state: 'connected', lastReadAt: '2026-11-02T12:00:00.000Z', alerts: 2 },
        { id: 'workstation', label: 'Workstation', state: 'connected', lastReadAt: '2026-11-02T12:00:00.000Z', alerts: 3 },
      ]);
      assert.deepEqual([...MACHINE_STATES], ['connected', 'unreachable', 'not-configured', 'incompatible-version']);
    } finally {
      await close();
    }
  });
});

describe('#175/AC-5 GET /api/telemetry', () => {
  test('padrão: local, 1 h; a versão, a leitura atual com as chaves em inglês, a série e os alertas', async () => {
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

  test('12 h em baldes, e a workstation com Docker, GPU e o volume cheio', async () => {
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

  test('parâmetro inválido dá 400; máquina que não existe, 404; sem telemetria, 404 nas duas', async () => {
    const { get, close } = await boot();
    try {
      // Vazio vale o padrão, como ausente.
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

  test('só GET, e as defesas da 0003: Origin de fora e Host estranho dão 403; a própria /ui lê', async () => {
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
  test('a amostra que abre um alerta acorda quem espera `type=alert`', async () => {
    const { get, store, tracker, cursor, close } = await boot();
    try {
      const start = (await (await get('/api/changes?wait=0')).json()) as { cursor: string };
      const pending = get(`/api/changes?since=${start.cursor}&wait=5&type=alert`);
      const exposed = reading({ ports: [{ port: 6379, interface: 'all', address: null, process: 'redis-server', pid: 9 }] }, NOW + 30_000);
      await new TelemetrySampler({ machineId: 'local', collector: new ScriptedCollector([exposed]), store, tracker, onAlertChange: publishAlertChanges(cursor) }).sampleOnce();
      const r = (await (await pending).json()) as { mudancas: { tipo: string; chave: string }[] };
      assert.ok(r.mudancas.some((m) => m.tipo === 'alert' && m.chave === 'local:port-exposed:6379'), JSON.stringify(r.mudancas));
    } finally {
      await close();
    }
  });
});

describe('#175/AC-6 simulador', () => {
  test('12 h semeadas, uma amostra a cada 30 s, a poda mantém a janela', async () => {
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

  test('a mesma hora dá a mesma leitura; a carga da workstation passa dos núcleos e volta', async () => {
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
