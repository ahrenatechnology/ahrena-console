// #173 phase 5, migration 11: the JSON inside `metadata` and `data` with English keys and values.
// The version 9 database of legacy-database.ts carries every Portuguese key and value the code wrote;
// after the core opens it, each one comes out mapped, nothing of ours is left in Portuguese, and the
// core's readers (state machine, plan history, panel, workflows) read the migrated rows.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { paraOPainel } from '../../src/api/decisions.ts';
import { contextoDe } from '../../src/api/panel.ts';
import { transcriptDe } from '../../src/api/reprocessing.ts';
import { ajustesDe, papelDe } from '../../src/api/workflows.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { planHistoryOf } from '../../src/plan/history.ts';
import { isSynthetic, readMemory } from '../../src/states/rules.ts';
import { JSON_CASES, NEW_SYNTHETIC_ID, OLD_SYNTHETIC_ID, T, rowCounts, writeLegacyDatabase } from './legacy-database.ts';

/** Every Portuguese key or value of ours that the old code wrote in the JSON columns. */
const OLD_WORDS = [
  'estados', 'ultimoEvento', 'idsNoUltimoInstante', 'erroEm', 'delegacoes', 'desde', 'descricao', 'comando', 'importacao',
  'simulado', 'roteiro', 'projeto', 'contexto', 'usados', 'limite', 'estouros', 'esforco', 'familia', 'mae', 'filhas',
  'travada', 'abandono', 'estouro', 'enxame', 'papel', 'ajustes', 'fase', 'rotulo', 'nome', 'extracao', 'aplicadas', 'ultima',
  'antes', 'provisorias', 'proximaTarefa', 'historico', 'aberto', 'inicio', 'herdados', 'texto', 'painel', 'painelDesfeito',
  'ruido', 'ajusteDe', 'acao', 'por', 'sessao', 'conta', 'em', 'nova', 'desfeitoEm', 'confirmar', 'descartar', 'ajustar',
  'usuario', 'a_confirmar', 'sintetico', 'fases', 'volta',
];

const dir = mkdtempSync(join(tmpdir(), 'ahrena-english-json-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('#173 phase 5: English keys and values in the stored JSON', () => {
  const path = join(dir, 'legacy.sqlite');
  let countsBefore: Record<string, number>;
  let store: SqliteStorage;
  let decisions: SqliteDecisionStore;
  const json = (table: string, column: string, where: string, ...params: string[]) =>
    JSON.parse((store.db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${where}`).get(...params) as { v: string }).v);

  before(() => {
    writeLegacyDatabase(path);
    const db = new DatabaseSync(path);
    countsBefore = rowCounts(db);
    db.close();
    store = openSqliteStorage({ path });
    decisions = new SqliteDecisionStore(store.db);
  });
  after(() => store.close());

  test('the JSON migration keeps every row', () => {
    const after = rowCounts(store.db);
    for (const t of ['sessions', 'agents', 'accounts', 'events', 'session_plans', 'session_plan_history', 'decisions']) assert.equal(after[t], countsBefore[t], t);
  });

  test('each object comes out with the English keys and values', () => {
    assert.deepEqual(json('sessions', 'metadata', 'id = ?', 's1'), JSON_CASES.sessionReal.new);
    assert.deepEqual(json('sessions', 'metadata', 'id = ?', 's2'), JSON_CASES.sessionSimulated.new);
    for (const [old, script] of Object.entries(JSON_CASES.scripts)) {
      assert.deepEqual(json('sessions', 'metadata', 'id = ?', `sim-${old}`), { simulated: true, script }, old);
    }
    assert.deepEqual(json('agents', 'metadata', 'id = ?', 's1:main'), JSON_CASES.agentReal.new);
    assert.deepEqual(json('agents', 'metadata', 'id = ?', 's2:main'), JSON_CASES.agentSimulated.new);
    assert.deepEqual(json('accounts', 'metadata', 'id = ?', 'acc/org'), JSON_CASES.account.new);
    assert.deepEqual(json('session_plans', 'metadata', 'session_id = ?', 's1'), JSON_CASES.plan.new);
    assert.deepEqual(json('decisions', 'metadata', 'id = ?', 'dec:old-0'), JSON_CASES.decisionConfirmed.new);
    assert.deepEqual(json('decisions', 'metadata', 'id = ?', 'dec:old-4'), JSON_CASES.decisionUndone.new);
    assert.deepEqual(json('events', 'data', 'id = ?', NEW_SYNTHETIC_ID), JSON_CASES.eventSynthetic.new);
    assert.deepEqual(json('events', 'data', 'id = ?', 'e1'), JSON_CASES.eventCompaction.new);
    assert.deepEqual(json('events', 'data', 'id = ?', 'e2'), JSON_CASES.eventWorkflow.new);
    assert.deepEqual(json('events', 'data', 'id = ?', 'e3'), JSON_CASES.eventHook.new, 'a hook payload is not ours: it stays');
  });

  test('the synthetic event gets the English id prefix, and the memory that pointed at it follows', () => {
    assert.equal(store.db.prepare('SELECT 1 FROM events WHERE id = ?').get(OLD_SYNTHETIC_ID), undefined);
    assert.ok(store.db.prepare('SELECT 1 FROM events WHERE id = ?').get(NEW_SYNTHETIC_ID));
  });

  test('no Portuguese key or value of ours is left in a JSON column (hook payloads aside)', () => {
    const columns: [string, string, string][] = [
      ['sessions', 'metadata', '1'], ['agents', 'metadata', '1'], ['accounts', 'metadata', '1'], ['session_plans', 'metadata', '1'],
      ['session_plan_history', 'metadata', '1'], ['decisions', 'metadata', '1'], ['events', 'data', `id <> 'e3'`],
    ];
    for (const [table, column, where] of columns) {
      const all = (store.db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${where}`).all() as { v: string | null }[]).map((r) => r.v ?? '').join('\n');
      for (const w of OLD_WORDS) assert.doesNotMatch(all, new RegExp(`"${w}"`), `${table}.${column}: ${w}`);
    }
  });

  test('the core reads what it wrote: machine memory, import cursor, plan history', async () => {
    const s1 = (await store.getSession('s1'))!;
    const memory = readMemory(s1);
    assert.deepEqual(memory.idsAtLastInstant, [NEW_SYNTHETIC_ID, 'e1']);
    assert.deepEqual(memory.delegations['tu-1'], { since: T, description: 'mapear o código' });
    assert.equal(memory.background['bg-1']?.command, 'npm run dev');
    assert.equal(transcriptDe({ ...s1, metadata: { import: s1.metadata.import } }, '/raiz'), '/raiz/-repo-app/s1.jsonl');
    const plan = await store.getPlan('s1');
    assert.deepEqual(planHistoryOf(plan), { seq: 1, open: true, start: T, inherited: JSON_CASES.plan.new.history.inherited });
    const [synthetic] = (await store.listEvents('s1')).items.filter((e) => e.type === 'SessionEnd');
    assert.equal(isSynthetic(synthetic!), true);
  });

  test('the core reads what it wrote: panel record, simulated context and workflow role', async () => {
    const confirmed = (await decisions.getDecision('dec:old-0'))!;
    const card = paraOPainel(confirmed, 's1', 's1', null, null);
    assert.equal(card.text, 'o texto inteiro');
    assert.equal(card.undo, 'confirm');
    assert.equal(card.confirmedAt, T);
    const s2 = (await store.getSession('s2'))!;
    assert.deepEqual([contextoDe(s2, { contexto: null, janelaLonga: false })?.used, contextoDe(s2, { contexto: null, janelaLonga: false })?.overflows], [82000, 1]);
    const agent = (await store.getAgent('s2:main'))!;
    assert.equal(papelDe({ ...agent, type: 'subagent' }), 'review');
    assert.equal(ajustesDe(agent), 3);
  });
});
