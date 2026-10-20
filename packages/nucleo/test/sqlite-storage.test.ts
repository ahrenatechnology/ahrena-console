import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { MIGRATIONS, migrate, schemaVersion, type Migration } from '../src/adapters/sqlite/migrations.ts';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { T0, account, event, session } from './fixtures.ts';
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
    assert.equal(b.schemaVersion, MIGRATIONS.at(-1)?.version);
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
  const ultima = MIGRATIONS.at(-1)!.version;
  const extra: Migration[] = [
    ...MIGRATIONS,
    { version: ultima + 1, description: 'coluna de teste', sql: 'ALTER TABLE sessions ADD COLUMN teste TEXT' },
  ];

  test('aplica só as que faltam, em ordem', () => {
    const db = new DatabaseSync(':memory:');
    assert.deepEqual(migrate(db, MIGRATIONS.slice(0, 1)), [1]);
    assert.deepEqual(migrate(db, MIGRATIONS), MIGRATIONS.slice(1).map((m) => m.version));
    assert.deepEqual(migrate(db, extra), [ultima + 1]);
    assert.deepEqual(migrate(db, extra), []);
    assert.equal(schemaVersion(db), ultima + 1);
    db.close();
  });

  test('migração que falha volta atrás e mantém a versão anterior', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS);
    const broken: Migration[] = [
      ...MIGRATIONS,
      { version: ultima + 1, description: 'quebrada', sql: 'CREATE TABLE ok (x TEXT); SELECT * FROM tabela_que_nao_existe;' },
    ];
    assert.throws(() => migrate(db, broken), new RegExp(`migração ${ultima + 1} \\(quebrada\\) falhou`));
    assert.equal(schemaVersion(db), ultima);
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

describe('migração 2: contas (decisão 0006)', () => {
  test('banco da versão 1 com dados ganha as contas, e as sessões antigas ficam em "Sem conta"', async () => {
    const path = join(dir, 'v1-com-dados.sqlite');
    const v1 = new DatabaseSync(path);
    migrate(v1, MIGRATIONS.filter((m) => m.version === 1));
    v1.prepare(
      `INSERT INTO sessions (id, name, status, cwd, model, source, started_at, updated_at, metadata)
       VALUES ('antiga', 'sessão de antes', 'completed', '/repo/app', 'claude-opus-5-5', 'import', ?, ?, '{"x":1}')`,
    ).run(T0, T0);
    v1.prepare(
      `INSERT INTO events (id, session_id, type, created_at) VALUES ('e-antigo', 'antiga', 'SessionStart', ?)`,
    ).run(T0);
    v1.close();

    const store = openSqliteStorage({ path });
    assert.equal(store.schemaVersion, MIGRATIONS.at(-1)?.version);
    const antiga = await store.getSession('antiga');
    assert.equal(antiga?.name, 'sessão de antes');
    assert.deepEqual(antiga?.metadata, { x: 1 });
    assert.equal(antiga?.accountId, null);
    assert.equal(antiga?.accountSource, null);
    assert.deepEqual((await store.listEvents('antiga')).items.map((e) => e.id), ['e-antigo']);
    assert.deepEqual((await store.listSessions({ accountIds: [null] })).items.map((s) => s.id), ['antiga']);

    const c = account();
    await store.putAccount(c);
    await store.putSession({ ...antiga!, accountId: c.id, accountSource: 'transcript' });
    assert.deepEqual((await store.listSessions({ accountIds: [c.id] })).items.map((s) => s.id), ['antiga']);
    assert.deepEqual((await store.listSessions({ accountIds: [null] })).items, []);
    await store.close();
  });

  test('cria o índice (account_id, updated_at DESC, id DESC) e o esquema barra procedência inválida', () => {
    const store = openSqliteStorage({ path: ':memory:' });
    const cols = store.db.prepare(`PRAGMA index_xinfo('sessions_by_account')`).all() as { name: string | null; desc: number; key: number }[];
    assert.deepEqual(
      cols.filter((c) => c.key === 1).map((c) => [c.name, c.desc]),
      [['account_id', 0], ['updated_at', 1], ['id', 1]],
    );
    const plano = store.db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE account_id = 'a/b' ORDER BY updated_at DESC, id DESC`)
      .all() as { detail: string }[];
    assert.ok(plano.some((p) => p.detail.includes('sessions_by_account')), JSON.stringify(plano));
    assert.throws(() =>
      store.db
        .prepare(`INSERT INTO sessions (id, status, started_at, updated_at, account_id, account_source)
                  VALUES ('x', 'active', 'a', 'b', 'u/o', 'palpite')`)
        .run(),
    );
  });
});

describe('migração 8: ordem de gravação dos eventos (feed, #94)', () => {
  test('banco da versão 7 com eventos ganha o seq na ordem em que entraram, e o próximo vem depois', async () => {
    const path = join(dir, 'v7-com-eventos.sqlite');
    const v7 = new DatabaseSync(path);
    migrate(v7, MIGRATIONS.filter((m) => m.version <= 7));
    const inserir = v7.prepare(`INSERT INTO events (id, session_id, type, created_at) VALUES (?, 's1', 'PreToolUse', ?)`);
    inserir.run('primeiro', T0);
    inserir.run('segundo', '2026-11-01T00:00:00.000Z'); // gravado depois, com createdAt mais velho
    v7.close();

    const store = openSqliteStorage({ path });
    const seqs = store.db.prepare('SELECT id, seq FROM events ORDER BY seq').all() as { id: string; seq: number }[];
    assert.deepEqual(seqs.map((r) => r.id), ['primeiro', 'segundo']);
    const p = await store.listRecentEvents();
    assert.deepEqual(p.items.map((e) => e.id), ['primeiro', 'segundo']);
    await store.appendEvent(event({ id: 'terceiro', createdAt: '2026-10-01T00:00:00.000Z' }));
    assert.deepEqual((await store.listRecentEvents({ after: p.liveCursor })).items.map((e) => e.id), ['terceiro']);
    await store.close();
  });

  test('a página do feed usa o índice por createdAt, e o ao vivo o de seq', () => {
    const store = openSqliteStorage({ path: ':memory:' });
    const plano = (sql: string) => JSON.stringify(store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all());
    assert.match(plano('SELECT * FROM events WHERE seq <= 9 ORDER BY created_at DESC, id DESC LIMIT 51'), /events_by_created/);
    assert.match(plano('SELECT * FROM events WHERE seq > 9 ORDER BY seq LIMIT 51'), /events_by_seq/);
  });
});
