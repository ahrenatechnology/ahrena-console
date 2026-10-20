// O armazenamento das amostras (#175/AC-2): a mesma bateria no adaptador SQLite (banco de verdade,
// em memória, com as migrações) e no dublê em memória dos testes dos casos de uso. A poda na escrita,
// a ordem, a janela, a leitura mais nova e a migração aditiva sobre um banco da versão 8.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../../src/adapters/sqlite/migrations.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { RETENTION_MS } from '../../src/telemetry/model.ts';
import type { TelemetryStore } from '../../src/telemetry/ports.ts';
import { MemoryTelemetryStore } from './doubles.ts';
import { reading, T0 } from './reading.ts';

const H = 3_600_000;

function contract(nome: string, abrir: () => { store: TelemetryStore; fechar: () => Promise<void> }) {
  describe(`#175/AC-2 armazenamento das amostras: ${nome}`, () => {
    test('poda na escrita: só as últimas 12 h da máquina; a outra máquina fica', async () => {
      const { store, fechar } = abrir();
      try {
        await store.putSample('workstation', reading({}, T0 - 20 * H), RETENTION_MS);
        for (const h of [13, 12.5, 11, 6, 0]) await store.putSample('local', reading({}, T0 - h * H), RETENTION_MS);
        const pts = await store.listPoints('local', 0);
        assert.deepEqual(pts.map((p) => (T0 - p.takenAt) / H), [11, 6, 0]);
        assert.equal((await store.listPoints('workstation', 0)).length, 1);
      } finally {
        await fechar();
      }
    });

    test('a janela pedida, do mais velho ao mais novo, com as colunas da série', async () => {
      const { store, fechar } = abrir();
      try {
        await store.putSample('local', reading({ cpu: { cores: 8, model: null, usedPct: null, load: { one: 9.5, five: 1, fifteen: 1 } } }, T0), RETENTION_MS);
        await store.putSample('local', reading({}, T0 - 2 * H), RETENTION_MS);
        await store.putSample('local', reading({ network: null }, T0 - 30_000), RETENTION_MS);
        const pts = await store.listPoints('local', T0 - H);
        assert.deepEqual(pts.map((p) => p.takenAt), [T0 - 30_000, T0]);
        assert.deepEqual(pts[0], { takenAt: T0 - 30_000, cpuUsedPct: 34, load1: 4.1, cores: 12, memoryUsedBytes: 21.4e9, swapUsedBytes: 0.8e9, rxBytesPerSec: null, txBytesPerSec: null, gpuUsedPct: null });
        assert.equal(pts[1].cpuUsedPct, null);
        assert.equal(pts[1].load1, 9.5);
      } finally {
        await fechar();
      }
    });

    test('a leitura mais nova, inteira; a mesma hora substitui; sem amostra é null', async () => {
      const { store, fechar } = abrir();
      try {
        assert.equal(await store.latest('local'), null);
        await store.putSample('local', reading({}, T0 - 30_000), RETENTION_MS);
        await store.putSample('local', reading({ host: { hostname: 'mac-exemplo', platform: 'darwin', os: null, arch: 'arm64', uptimeSec: 1 } }, T0), RETENTION_MS);
        await store.putSample('local', reading({}, T0), RETENTION_MS);
        assert.deepEqual(await store.latest('local'), reading({}, T0));
        assert.equal((await store.listPoints('local', 0)).length, 2);
      } finally {
        await fechar();
      }
    });
  });
}

contract('SQLite', () => {
  const storage = openSqliteStorage({ path: ':memory:' });
  return { store: new SqliteTelemetryStore(storage.db), fechar: () => storage.close() };
});
contract('dublê em memória', () => ({ store: new MemoryTelemetryStore(), fechar: async () => {} }));

describe('#175/AC-2 migração da tabela de amostras', () => {
  test('aditiva sobre um banco da versão 8; sem ela, o adaptador recusa o banco', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 8));
    assert.throws(() => new SqliteTelemetryStore(db), /sem a tabela de telemetria/);
    assert.deepEqual(migrate(db), [9]);
    assert.equal(schemaVersion(db), 9);
    const cols = (db.prepare('PRAGMA table_info(telemetry_samples)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['machine_id', 'taken_at', 'cpu_used_pct', 'load1', 'cores', 'memory_used_bytes', 'swap_used_bytes', 'rx_bytes_per_sec', 'tx_bytes_per_sec', 'gpu_used_pct', 'reading']);
    new SqliteTelemetryStore(db);
    db.close();
  });
});
