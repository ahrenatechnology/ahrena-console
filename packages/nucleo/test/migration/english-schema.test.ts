// #173 phase 5: the migration to the English schema keeps every row. A version 9 database with every
// Portuguese value the code stored goes through the core; each table keeps its row count, each value
// comes out mapped, and the core reads all of it. Running it twice changes nothing, and a new database
// is born on the English schema.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { MIGRATIONS, migrate, schemaVersion } from '../../src/adapters/sqlite/migrations.ts';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { validateDecision, validateSessionLink } from '../../src/decisions/model.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import {
  ADJUSTED_ID,
  CACHE_KEYS_RENAMED,
  CACHE_KEYS_KEPT,
  DECIDERS,
  INFERRED_NEW_ID,
  INFERRED_OLD_ID,
  LEGACY_VERSION,
  LINK_REASONS,
  ORIGINS,
  REPROCESSINGS,
  SCOPES,
  STATES,
  TOPICS,
  WINDOW_SOURCES,
  legacyDecisions,
  rowCounts,
  writeLegacyDatabase,
} from './legacy-database.ts';

const LATEST = MIGRATIONS.at(-1)!.version;
const RENAMED_TABLES: Record<string, string> = { reprocessamentos: 'reprocessings' };
/** Tables that later migrations add, empty (#241: the installation's settings). */
const ADDED_TABLES: Record<string, number> = { installation_settings: 0 };
/** Every Portuguese name and value the old schema had; none may remain in the new one. */
const PORTUGUESE = [
  'reprocessamentos', 'nome', 'feito_em', 'faltando',
  ...Object.keys(WINDOW_SOURCES), ...Object.keys(DECIDERS), ...Object.keys(ORIGINS), ...Object.keys(STATES), 'sessao', 'familia', 'filha',
];

const dir = mkdtempSync(join(tmpdir(), 'ahrena-english-schema-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function schemaSql(db: DatabaseSync): string {
  return (db.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name`).all() as { sql: string }[]).map((r) => r.sql).join('\n');
}

function dump(db: DatabaseSync): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of Object.keys(rowCounts(db))) out[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2`).all();
  return out;
}

describe('#173 phase 5: English schema migration over a version 9 database', () => {
  const path = join(dir, 'legacy.sqlite');
  let countsBefore: Record<string, number>;
  let store: SqliteStorage;
  let decisions: SqliteDecisionStore;

  before(() => {
    writeLegacyDatabase(path);
    const db = new DatabaseSync(path);
    assert.equal(schemaVersion(db), LEGACY_VERSION);
    countsBefore = rowCounts(db);
    db.close();
    store = openSqliteStorage({ path });
    decisions = new SqliteDecisionStore(store.db);
  });
  after(() => store.close());

  test('the database reaches the latest version', () => {
    assert.equal(store.schemaVersion, LATEST);
  });

  test('every table keeps its rows, the GitHub cache included', () => {
    const expected = { ...Object.fromEntries(Object.entries(countsBefore).map(([t, n]) => [RENAMED_TABLES[t] ?? t, n])), ...ADDED_TABLES };
    assert.deepEqual(rowCounts(store.db), expected);
    for (const n of Object.values(countsBefore)) assert.ok(n > 0, 'the old database has rows in every table');
  });

  test('no Portuguese table, column, trigger or CHECK value is left in the schema', () => {
    const sql = schemaSql(store.db);
    for (const word of PORTUGUESE) assert.doesNotMatch(sql, new RegExp(`\\b${word}\\b`), word);
    const columns = (store.db.prepare('PRAGMA table_info(reprocessings)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(columns, ['name', 'done_at']);
    const triggers = (store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]).map((t) => t.name);
    assert.deepEqual(triggers, ['events_seq_missing']);
  });

  test('the indexes of the rebuilt tables are back', () => {
    const indexes = (store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).all() as { name: string }[]).map((i) => i.name);
    for (const name of ['decisions_by_session', 'decisions_by_family', 'decisions_by_branch', 'decisions_by_family_seq', 'session_links_by_family', 'events_by_seq']) {
      assert.ok(indexes.includes(name), name);
    }
  });

  test('the reprocessings keep their date under the new names', () => {
    const rows = store.db.prepare('SELECT name, done_at FROM reprocessings ORDER BY name').all() as { name: string; done_at: string }[];
    assert.deepEqual(rows.map((r) => r.name).sort(), Object.values(REPROCESSINGS).sort());
    for (const name of ['plans-and-decisions-1', 'decision-noise-1', 'context-1']) assert.equal(store.isReprocessed(name), true, name);
    assert.equal(store.isReprocessed('planos-e-decisoes-1'), false);
  });

  test('each context meter has its window source mapped, and the core reads them', async () => {
    const meters = await store.listContextMeters('s1');
    assert.deepEqual(meters.map((m) => m.windowSource).sort(), Object.values(WINDOW_SOURCES).sort());
  });

  test('each decision has every value mapped and the core reads it', async () => {
    for (const old of legacyDecisions()) {
      const id = old.id === INFERRED_OLD_ID ? INFERRED_NEW_ID : old.id;
      const d = await decisions.getDecision(id);
      assert.ok(d, id);
      validateDecision(d);
      assert.equal(d.decidedBy, DECIDERS[old.decidedBy], `${id} decidedBy`);
      assert.equal(d.origin, ORIGINS[old.origin], `${id} origin`);
      assert.equal(d.state, STATES[old.state], `${id} state`);
      assert.equal(d.scope, SCOPES[old.scope], `${id} scope`);
      assert.equal(d.topic, old.topic === null ? null : TOPICS[old.topic], `${id} topic`);
    }
    for (const v of [...Object.values(DECIDERS), ...Object.values(ORIGINS), ...Object.values(STATES), ...Object.values(SCOPES)]) {
      assert.ok(JSON.stringify(dump(store.db).decisions).includes(`"${v}"`), `some decision has ${v}`);
    }
  });

  test('the inferred decision gets the new source key and id, and whatever pointed at it follows', async () => {
    assert.equal(await decisions.getDecision(INFERRED_OLD_ID), null);
    const inferred = await decisions.getDecision(INFERRED_NEW_ID);
    const adjusted = await decisions.getDecision(ADJUSTED_ID);
    assert.equal(inferred?.sourceKey, 'inferred:u-7');
    assert.equal(adjusted?.sourceKey, `painel:${INFERRED_OLD_ID}:2026-10-01T12:05:00.000Z`, "the Adjust's source key and id stay");
    assert.equal(inferred?.supersededBy, ADJUSTED_ID);
    assert.equal(adjusted?.supersedes, INFERRED_NEW_ID);
    assert.ok(JSON.stringify(adjusted?.metadata).includes(INFERRED_NEW_ID), 'the adjustment points at the new id');
    const left = store.db
      .prepare('SELECT COUNT(*) AS n FROM decisions WHERE id = ? OR supersedes = ? OR superseded_by = ? OR instr(metadata, ?) > 0')
      .get(INFERRED_OLD_ID, INFERRED_OLD_ID, INFERRED_OLD_ID, INFERRED_OLD_ID) as { n: number };
    assert.equal(left.n, 0, 'nothing points at the old id');
  });

  test('the decisions are listed by the port with the English filters', async () => {
    const page = await decisions.listDecisions({ familyId: 's1', states: ['current', 'to_confirm'], limit: 100 });
    assert.deepEqual(page.items.map((d) => d.state).sort(), ['current', 'current', 'to_confirm']);
  });

  test('each session link has its reason mapped, and the core reads them', async () => {
    const links = await decisions.listSessionLinks('s1');
    for (const l of links) validateSessionLink(l);
    assert.deepEqual(links.map((l) => l.reason).sort(), Object.values(LINK_REASONS).sort());
  });

  test('the rest of the core reads what it read before', async () => {
    assert.equal((await store.listSessions({ limit: 100 })).items.length, countsBefore.sessions);
    assert.equal((await store.listAgents('s1')).length, 1);
    assert.equal((await store.listEvents('s1')).items.length, 4);
    assert.equal((await store.listTokenUsage('s1')).length, 1);
    assert.equal((await store.listModelPricing()).length, 1);
    assert.equal((await store.listAccounts()).length, 1);
    assert.equal((await store.getPlan('s1'))?.steps.length, 1);
    assert.equal((await store.listPlanRecords('s1')).length, 1);
    assert.equal((await new SqliteTelemetryStore(store.db).latest('local')) !== null, true);
  });

  test('the GitHub cache moves each Portuguese key to its English key, with its value, time and etag', async () => {
    const cache = new SqliteCacheStore(store.db);
    const all = [...Object.keys(CACHE_KEYS_RENAMED), ...CACHE_KEYS_KEPT];
    for (const [oldKey, newKey] of Object.entries(CACHE_KEYS_RENAMED)) {
      const i = all.indexOf(oldKey);
      assert.equal(await cache.get(oldKey), null, oldKey);
      assert.deepEqual(await cache.get(newKey), { value: { from: oldKey }, fetchedAt: 1000 + i, etag: `etag-${i}` }, newKey);
    }
    for (const key of CACHE_KEYS_KEPT) {
      const i = all.indexOf(key);
      assert.deepEqual(await cache.get(key), { value: { from: key }, fetchedAt: 1000 + i, etag: `etag-${i}` }, key);
    }
  });

  test('the renamed trigger still fills the seq of an event written without it', () => {
    store.db.prepare(`INSERT INTO events (id, session_id, type, created_at) VALUES ('late', 's1', 'Stop', '2026-10-01T12:00:00.000Z')`).run();
    const row = store.db.prepare(`SELECT seq FROM events WHERE id = 'late'`).get() as { seq: number };
    assert.equal(row.seq, 5);
    store.db.prepare(`DELETE FROM events WHERE id = 'late'`).run();
  });

  test('the CHECKs refuse the old values', () => {
    assert.throws(() => store.db.prepare(`UPDATE decisions SET state = 'vigente' WHERE id = 'dec:old-0'`).run(), /CHECK/);
    assert.throws(() => store.db.prepare(`UPDATE context_meters SET window_source = 'modelo'`).run(), /CHECK/);
    assert.throws(() => store.db.prepare(`UPDATE session_links SET reason = 'filha'`).run(), /CHECK/);
  });
});

describe('#173 phase 5: the migration is idempotent', () => {
  test('opening the core twice migrates once and changes nothing the second time', async () => {
    const path = join(dir, 'twice.sqlite');
    writeLegacyDatabase(path);
    const first = openSqliteStorage({ path });
    const afterFirst = dump(first.db);
    await first.close();

    const second = openSqliteStorage({ path });
    assert.equal(second.schemaVersion, LATEST);
    assert.deepEqual(migrate(second.db), [], 'nothing left to apply');
    assert.deepEqual(dump(second.db), afterFirst);
    await second.close();
  });
});

describe('#173 phase 5: a new database', () => {
  test('is born on the English schema', () => {
    const store = openSqliteStorage({ path: ':memory:' });
    assert.equal(store.schemaVersion, LATEST);
    const sql = schemaSql(store.db);
    for (const word of PORTUGUESE) assert.doesNotMatch(sql, new RegExp(`\\b${word}\\b`), word);
    assert.match(sql, /CREATE TABLE "?reprocessings"?/);
    assert.match(sql, /CREATE TRIGGER events_seq_missing/);
    store.markReprocessed('context-1', '2026-10-01T12:00:00.000Z');
    assert.equal(store.isReprocessed('context-1'), true);
  });
});
