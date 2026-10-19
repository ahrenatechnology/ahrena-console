// Histórico dos planos da sessão (issue #131), com eventos de hook e transcripts sintéticos.
// Nenhum conteúdo real entra no repositório.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/adapters/sqlite/migrations.ts';
import { importHistory } from '../src/ingest/historico/importer.ts';
import { ingestHook } from '../src/ingest/hooks/index.ts';
import { atualizarPlano, separarPlano, type PlanRecord, type PlanStep } from '../src/plano/index.ts';
import { at, event } from './fixtures.ts';

const SID = 'sess-historico-1';
const common = { session_id: SID, cwd: '/repo/app', transcript_path: '/home/dev/.claude/projects/-repo-app/sess-historico-1.jsonl' };

let store: SqliteStorage;
beforeEach(() => {
  store = openSqliteStorage({ path: ':memory:' });
});

let chamada = 0;
async function hook(minuto: number, tool_name: string, tool_input: unknown, tool_response: unknown = {}): Promise<void> {
  const base = { ...common, tool_name, tool_input, tool_use_id: `toolu_h${++chamada}` };
  await ingestHook(store, { ...base, hook_event_name: 'PreToolUse' }, { receivedAt: at(minuto) });
  await ingestHook(store, { ...base, hook_event_name: 'PostToolUse', tool_response }, { receivedAt: at(minuto) });
}

type St = 'pending' | 'in_progress' | 'completed';
const todos = (minuto: number, ...itens: [string, St][]) =>
  hook(minuto, 'TodoWrite', { todos: itens.map(([content, status]) => ({ content, status, activeForm: content })) });

/** Os planos como linhas fáceis de comparar, do mais recente para o mais antigo. */
const historico = async () =>
  (await store.listPlanRecords(SID)).map((r) => ({
    seq: r.seq,
    result: r.result,
    feitos: `${r.done}/${r.total}`,
    passos: r.steps.map((s) => s.text),
    inicio: r.startedAt,
    fim: r.endedAt,
  }));

const passo = (text: string, status: St = 'pending', id = text): PlanStep => ({
  id, text, activeText: null, status, owner: { kind: 'main', agentId: null, name: null }, updatedAt: at(0),
});

describe('CA1: a separação dos planos (função pura)', () => {
  const abc = [passo('Ler', 'completed'), passo('Escrever', 'in_progress'), passo('Testar')];

  test('ajustes continuam no plano: marcar, reordenar, acrescentar e renomear', () => {
    assert.equal(separarPlano(abc, [passo('Ler', 'completed'), passo('Escrever', 'completed'), passo('Testar', 'in_progress')]), 'continua');
    assert.equal(separarPlano(abc, [abc[2], abc[0], abc[1]]), 'continua');
    assert.equal(separarPlano(abc, [...abc, passo('Abrir o PR'), passo('Pedir review')]), 'continua');
    assert.equal(separarPlano(abc, [abc[0], passo('Escrever o teste', 'in_progress'), abc[2]]), 'continua');
    assert.equal(separarPlano(abc, [abc[0], abc[1]]), 'continua');
  });

  test('a lista trocada por outra substancialmente diferente é um plano novo', () => {
    assert.equal(separarPlano(abc, [passo('Medir'), passo('Cachear'), passo('Ler')]), 'novo');
    assert.equal(separarPlano(abc, [passo('Outra coisa')]), 'novo');
  });

  test('o anterior terminou e vem outro: plano novo; desmarcar ou renomear um feito continua', () => {
    const feito = abc.map((s) => ({ ...s, status: 'completed' as const }));
    assert.equal(separarPlano(feito, [...feito, passo('Publicar')]), 'novo');
    assert.equal(separarPlano(feito, feito.map((s) => ({ ...s, status: 'pending' as const }))), 'novo');
    assert.equal(separarPlano(feito, [feito[0], feito[1], passo('Testar', 'in_progress')]), 'continua');
    assert.equal(separarPlano(feito, [feito[0], feito[1], passo('Testar tudo', 'completed')]), 'continua');
  });

  test('mudança de um passo só (TaskCreate, TaskUpdate) nunca troca o plano que não terminou', () => {
    assert.equal(separarPlano([passo('Ler', 'in_progress')], [passo('Ler', 'in_progress'), passo('A'), passo('B')], true), 'continua');
    assert.equal(separarPlano([passo('Ler', 'in_progress')], [passo('Ler de novo', 'in_progress', 'Ler')], true), 'continua');
    assert.equal(separarPlano([passo('Ler', 'completed')], [passo('Ler', 'completed'), passo('A')], true), 'novo');
  });

  test('lista vazia fecha o plano; o primeiro plano começa do nada', () => {
    assert.equal(separarPlano(abc, []), 'fim');
    assert.equal(separarPlano([], []), 'continua');
    assert.equal(separarPlano([], abc), 'novo');
  });
});

describe('CA1 e CA2: vários planos numa sessão, pelos hooks', () => {
  test('cada plano com início, fim, passos, feitos/total e resultado', async () => {
    await todos(1, ['Ler o código', 'in_progress'], ['Escrever o teste', 'pending'], ['Abrir o PR', 'pending']);
    await todos(2, ['Ler o código', 'completed'], ['Escrever o teste', 'in_progress'], ['Abrir o PR', 'pending']);
    // Trocou de ideia: outra lista, o primeiro fica abandonado com 1 de 3.
    await todos(3, ['Medir a consulta', 'in_progress'], ['Criar o índice', 'pending']);
    await todos(4, ['Medir a consulta', 'completed'], ['Criar o índice', 'completed']);
    // O segundo terminou; vem outro.
    await todos(5, ['Atualizar a doc', 'in_progress']);

    assert.deepEqual(await historico(), [
      { seq: 3, result: 'current', feitos: '0/1', passos: ['Atualizar a doc'], inicio: at(5), fim: null },
      { seq: 2, result: 'completed', feitos: '2/2', passos: ['Medir a consulta', 'Criar o índice'], inicio: at(3), fim: at(5) },
      { seq: 1, result: 'abandoned', feitos: '1/3', passos: ['Ler o código', 'Escrever o teste', 'Abrir o PR'], inicio: at(1), fim: at(3) },
    ]);
    // O plano da sessão segue sendo a lista do momento.
    assert.equal((await store.getPlan(SID))!.total, 1);
  });

  test('reescrita que só ajusta (marca, reordena, acrescenta, renomeia) fica no mesmo plano', async () => {
    await todos(1, ['Ler', 'in_progress'], ['Escrever', 'pending'], ['Testar', 'pending']);
    await todos(2, ['Ler', 'completed'], ['Testar', 'pending'], ['Escrever', 'in_progress']);
    await todos(3, ['Ler', 'completed'], ['Testar tudo', 'pending'], ['Escrever', 'in_progress'], ['Abrir o PR', 'pending']);
    const h = await historico();
    assert.equal(h.length, 1);
    assert.deepEqual(h[0], { seq: 1, result: 'current', feitos: '1/4', passos: ['Ler', 'Testar tudo', 'Escrever', 'Abrir o PR'], inicio: at(1), fim: null });
  });

  test('plano terminado continua o atual até vir outro', async () => {
    await todos(1, ['Ler', 'completed'], ['Escrever', 'completed']);
    assert.deepEqual((await historico()).map((r) => [r.result, r.feitos]), [['current', '2/2']]);
  });

  test('TaskCreate depois das tarefas feitas abre um plano só com as novas', async () => {
    await hook(1, 'TaskCreate', { subject: 'Ler', description: 'd' }, { task: { id: '1' } });
    await hook(2, 'TaskCreate', { subject: 'Testar', description: 'd' }, { task: { id: '2' } });
    await hook(3, 'TaskUpdate', { taskId: '1', status: 'completed' });
    await hook(4, 'TaskUpdate', { taskId: '2', status: 'completed' });
    await hook(5, 'TaskCreate', { subject: 'Publicar', description: 'd' }, { task: { id: '3' } });
    await hook(6, 'TaskUpdate', { taskId: '3', status: 'in_progress' });
    await hook(7, 'TaskCreate', { subject: 'Avisar o time', description: 'd' }, { task: { id: '4' } });
    assert.deepEqual(await historico(), [
      { seq: 2, result: 'current', feitos: '0/2', passos: ['Publicar', 'Avisar o time'], inicio: at(5), fim: null },
      { seq: 1, result: 'completed', feitos: '2/2', passos: ['Ler', 'Testar'], inicio: at(1), fim: at(5) },
    ]);
    // As tarefas antigas continuam na lista da ferramenta, mas o plano atual é o das novas.
    assert.equal((await store.getPlan(SID))!.total, 4);
    const atual = (await store.listPlanRecords(SID))[0];
    assert.equal(atual.steps.find((s) => s.id === atual.currentStepId)?.text, 'Publicar');
  });

  test('update_plan: items abre o plano, advance anda nele', async () => {
    await hook(1, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Ler', status: 'in_progress' }, { content: 'Fazer', status: 'pending' }] });
    await hook(2, 'mcp__ccd_turn__update_plan', { advance: true });
    await hook(3, 'mcp__ccd_turn__update_plan', { advance: true });
    await hook(4, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Revisar o PR', status: 'in_progress' }] });
    assert.deepEqual((await historico()).map((r) => [r.seq, r.result, r.feitos]), [[2, 'current', '0/1'], [1, 'completed', '2/2']]);
  });
});

describe('CA1: /clear', () => {
  test('/clear fecha o plano (abandonado com X de Y); o próximo é outro plano', async () => {
    await todos(1, ['Ler', 'completed'], ['Escrever', 'in_progress'], ['Testar', 'pending']);
    await ingestHook(store, { ...common, hook_event_name: 'SessionStart', source: 'clear' }, { receivedAt: at(2) });
    assert.deepEqual((await historico()).map((r) => [r.seq, r.result, r.feitos, r.fim]), [[1, 'abandoned', '1/3', at(2)]]);
    // A mesma lista depois do /clear é outro plano, do zero.
    await todos(3, ['Ler', 'in_progress'], ['Escrever', 'pending'], ['Testar', 'pending']);
    assert.deepEqual((await historico()).map((r) => [r.seq, r.result, r.feitos, r.inicio]), [[2, 'current', '0/3', at(3)], [1, 'abandoned', '1/3', at(1)]]);
  });

  test('/clear sem plano não cria nada', async () => {
    await ingestHook(store, { ...common, hook_event_name: 'SessionStart', source: 'clear' }, { receivedAt: at(1) });
    assert.deepEqual(await store.listPlanRecords(SID), []);
  });
});

describe('CA2: gravado pela porta, migração aditiva', () => {
  test('plano gravado antes do histórico vira o primeiro na próxima mudança', async () => {
    await store.putPlan({
      sessionId: SID, source: 'TodoWrite', steps: [{ ...passo('Ler', 'in_progress', '1') }, { ...passo('Escrever', 'pending', '2') }],
      done: 0, total: 2, currentStepId: '1', changedAt: at(1), metadata: {},
    });
    await todos(4, ['Ler', 'completed'], ['Escrever', 'in_progress']);
    assert.deepEqual(await historico(), [{ seq: 1, result: 'current', feitos: '1/2', passos: ['Ler', 'Escrever'], inicio: at(1), fim: null }]);
  });

  test('vários eventos de uma vez gravam o mesmo histórico que um a um', async () => {
    const tw = (m: number, ...itens: [string, St][]) =>
      event({ sessionId: SID, agentId: null, type: 'ToolUse', toolName: 'TodoWrite', createdAt: at(m), data: { toolUseId: `t${m}`, tool_input: { todos: itens.map(([content, status]) => ({ content, status })) } } });
    await atualizarPlano(store, SID, [tw(1, ['A', 'completed']), tw(2, ['B', 'in_progress']), tw(3, ['B', 'completed'], ['C', 'pending'])]);
    assert.deepEqual((await historico()).map((r) => [r.seq, r.result, r.passos]), [[2, 'current', ['B', 'C']], [1, 'completed', ['A']]]);
  });

  test('banco da versão 4 ganha a tabela session_plan_history, sem mexer no que existe', () => {
    const m = MIGRATIONS.find((x) => x.sql.includes('CREATE TABLE session_plan_history'))!;
    assert.doesNotMatch(m.sql, /\b(DROP|ALTER)\b/);
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((x) => x.version < m.version));
    assert.deepEqual(migrate(db, MIGRATIONS.filter((x) => x.version <= m.version)), [m.version]);
    assert.equal(schemaVersion(db), m.version);
    const cols = (db.prepare('PRAGMA table_info(session_plan_history)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['session_id', 'seq', 'source', 'started_at', 'ended_at', 'result', 'steps', 'done', 'total', 'current_step_id', 'changed_at', 'metadata']);
    db.close();
  });
});

describe('CA1: pelo transcript (importador)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ahrena-historico-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const S = '00000000-0000-4000-8000-0000000000b1';
  let linha = 0;
  const uuid = () => `00000000-0000-4000-9000-${String(++linha).padStart(12, '0')}`;
  const todoWrite = (m: number, itens: [string, St][]) =>
    JSON.stringify({
      type: 'assistant', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: S, cwd: '/repo/app',
      message: { id: `msg_${linha}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `toolu_t${linha}`, name: 'TodoWrite', input: { todos: itens.map(([content, status]) => ({ content, status, activeForm: content })) } }] },
    });
  const clear = (m: number) =>
    JSON.stringify({ type: 'user', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: S, message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } });

  test('reescrita, /clear e plano novo saem do transcript', async () => {
    const root = join(tmp, 'projetos');
    mkdirSync(join(root, '-repo-app'), { recursive: true });
    writeFileSync(
      join(root, '-repo-app', `${S}.jsonl`),
      [
        todoWrite(1, [['Ler', 'in_progress'], ['Escrever', 'pending']]),
        todoWrite(2, [['Ler', 'completed'], ['Escrever', 'completed']]),
        todoWrite(3, [['Publicar', 'in_progress'], ['Avisar', 'pending']]),
        clear(4),
        todoWrite(5, [['Recomeçar', 'in_progress']]),
      ].map((l) => `${l}\n`).join(''),
    );
    await importHistory({ storage: store, root });
    const r: PlanRecord[] = await store.listPlanRecords(S);
    assert.deepEqual(
      r.map((x) => [x.seq, x.result, `${x.done}/${x.total}`, x.startedAt, x.endedAt]),
      [
        [3, 'current', '0/1', at(5), null],
        [2, 'abandoned', '0/2', at(3), at(4)],
        [1, 'completed', '2/2', at(1), at(3)],
      ],
    );
  });
});
