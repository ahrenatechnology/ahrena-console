import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { MIGRATIONS, migrate, schemaVersion, type Migration } from '../src/adapters/sqlite/migrations.ts';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { session } from './fixtures.ts';
import { storageContract } from './storage-contract.ts';

storageContract('SQLite em memória', async () => openSqliteStorage({ path: ':memory:' }));

const dir = mkdtempSync(join(tmpdir(), 'ahrena-nucleo-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
storageContract('SQLite em arquivo (WAL)', async () => openSqliteStorage({ path: join(dir, `contrato-${n++}.sqlite`) }));

describe('adaptador SQLite', () => {
  test('banco novo nasce na última versão do esquema', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    assert.equal(store.schemaVersion, MIGRATIONS.at(-1)?.version);
    await store.close();
  });

  test('os dados sobrevivem a fechar e reabrir, sem reaplicar migrações', async () => {
    const path = join(dir, 'reabrir.sqlite');
    const a = openSqliteStorage({ path });
    await a.putSession(session());
    await a.close();

    const b = openSqliteStorage({ path });
    assert.equal(b.schemaVersion, 1);
    assert.equal((await b.getSession('s1'))?.id, 's1');
    assert.equal((b.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    await b.close();
  });

  test('o esquema também barra status inválido (CHECK), não só o validador', () => {
    const store = openSqliteStorage({ path: ':memory:' });
    assert.throws(() =>
      store.db
        .prepare(`INSERT INTO sessions (id, status, started_at, updated_at) VALUES ('x', 'waiting', 'a', 'b')`)
        .run(),
    );
  });

  test('close é idempotente', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    await store.close();
    await store.close();
  });
});

describe('migrações', () => {
  const extra: Migration[] = [
    ...MIGRATIONS,
    { version: 2, description: 'coluna de teste', sql: 'ALTER TABLE sessions ADD COLUMN teste TEXT' },
  ];

  test('aplica só as que faltam, em ordem', () => {
    const db = new DatabaseSync(':memory:');
    assert.deepEqual(migrate(db, MIGRATIONS), [1]);
    assert.deepEqual(migrate(db, extra), [2]);
    assert.deepEqual(migrate(db, extra), []);
    assert.equal(schemaVersion(db), 2);
    db.close();
  });

  test('migração que falha volta atrás e mantém a versão anterior', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS);
    const broken: Migration[] = [
      ...MIGRATIONS,
      { version: 2, description: 'quebrada', sql: 'CREATE TABLE ok (x TEXT); SELECT * FROM tabela_que_nao_existe;' },
    ];
    assert.throws(() => migrate(db, broken), /migração 2 \(quebrada\) falhou/);
    assert.equal(schemaVersion(db), 1);
    assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'ok'`).get(), undefined);
    db.close();
  });

  test('recusa banco mais novo que o código', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, extra);
    assert.throws(() => migrate(db, MIGRATIONS), /mais nova que a deste código/);
    db.close();
  });
});
