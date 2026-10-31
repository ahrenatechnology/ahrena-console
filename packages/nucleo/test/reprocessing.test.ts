// What the old import left out (#131): plans and decisions of the already imported sessions,
// the `wrap_up` that closes the `update_plan` list and the capture of decisions on import.
// Synthetic transcripts; no real content enters the repository.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate } from '../src/adapters/sqlite/migrations.ts';
import { capturarDoTranscript, limparDecisoes, reprocessarHistorico, reprocessMessageText } from '../src/api/reprocessing.ts';
import { registerDecision } from '../src/decisions/registry.ts';
import { SqliteDecisionStore } from '../src/decisions/sqlite.ts';
import { importHistory } from '../src/ingest/history/importer.ts';
import { ingestHook } from '../src/ingest/hooks/index.ts';
import { ASK_ANSWERS, ASK_INPUT, at, jsonl, tx } from './decisions/helpers.ts';

const S = '00000000-0000-4000-8000-0000000000c1';
let store: SqliteStorage;
let decisoes: SqliteDecisionStore;
beforeEach(() => {
  store = openSqliteStorage({ path: ':memory:' });
  decisoes = new SqliteDecisionStore(store.db);
});

const tmp = mkdtempSync(join(tmpdir(), 'ahrena-reprocessamento-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** Um projeto com o transcript da sessão S. */
function projeto(linhas: unknown[]): { root: string; arquivo: string } {
  const root = join(tmp, `p${++n}`);
  mkdirSync(join(root, '-repo-app'), { recursive: true });
  const arquivo = join(root, '-repo-app', `${S}.jsonl`);
  writeFileSync(arquivo, jsonl(linhas).map((l) => `${l}\n`).join(''));
  return { root, arquivo };
}

const o = (uuid: string, minute: number) => ({ uuid, minute, sessionId: S });
const itens = (...xs: [string, string][]) => ({ items: xs.map(([content, status]) => ({ content, status })) });
const UPDATE = 'mcp__ccd_turn__update_plan';
const WRAP = 'mcp__ccd_turn__wrap_up';

const historico = async () => (await store.listPlanRecords(S)).map((r) => [r.seq, r.result, `${r.done}/${r.total}`]);

describe('wrap_up fecha a lista do update_plan', () => {
  test('o plano fechado pelo wrap_up é concluído, não abandonado', async () => {
    const { root } = projeto([
      tx.toolUse(o('a1', 1), 't1', UPDATE, itens(['Ler', 'in_progress'], ['Fazer', 'pending'])),
      tx.toolUse(o('a2', 2), 't2', UPDATE, { advance: true }),
      tx.toolUse(o('a3', 3), 't3', WRAP, { recap: 'feito' }),
      tx.toolUse(o('a4', 4), 't4', UPDATE, itens(['Outra coisa', 'in_progress'])),
    ]);
    await importHistory({ storage: store, root });
    assert.deepEqual(await historico(), [[2, 'current', '0/1'], [1, 'completed', '2/2']]);
  });

  test('wrap_up não mexe na lista do TodoWrite nem na de um subagente', async () => {
    const base = { session_id: S, cwd: '/repo/app', transcript_path: '/x.jsonl' };
    const h = (m: number, tool_name: string, tool_input: unknown, extra: object = {}) =>
      ingestHook(store, { ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: `h${m}`, ...extra }, { receivedAt: at(m) });
    await h(1, 'TodoWrite', { todos: [{ content: 'A', status: 'in_progress' }] });
    await h(2, WRAP, {});
    assert.deepEqual(await historico(), [[1, 'current', '0/1']]);
    await h(3, UPDATE, itens(['B', 'in_progress']));
    await h(4, WRAP, {}, { agent_id: 'sub-1' });
    assert.deepEqual((await store.getPlan(S))!.done, 0);
  });
});

describe('reprocessamento das sessões já importadas', () => {
  test('refaz os planos com a entrada relida do transcript e captura as decisões', async () => {
    const { root } = projeto([
      tx.prompt(o('p1', 0), 'começa'),
      tx.toolUse(o('a1', 1), 't1', UPDATE, itens(['Ler', 'in_progress'], ['Fazer', 'pending'])),
      tx.toolUse(o('a2', 2), 't2', WRAP, {}),
      tx.toolUse(o('a3', 3), 'toolu_ask', 'AskUserQuestion', ASK_INPUT),
      tx.toolResult(o('a4', 4), 'toolu_ask', 'Your questions have been answered', { toolUseResult: { questions: ASK_INPUT.questions, answers: ASK_ANSWERS } }),
      tx.toolUse(o('a5', 5), 't5', UPDATE, itens(['Testar', 'in_progress'], ['Publicar', 'pending'])),
      tx.toolUse(o('a6', 6), 't6', UPDATE, itens(['Medir', 'in_progress'])),
    ]);
    await importHistory({ storage: store, root });
    // A importação antiga: os eventos sem a entrada das ferramentas do plano, sem plano nem decisões.
    store.db.exec("UPDATE events SET data = json_remove(data, '$.tool_input')");
    store.db.exec('DELETE FROM session_plans; DELETE FROM session_plan_history');
    assert.deepEqual(await historico(), []);

    const r = await reprocessarHistorico({ storage: store, decisoes, root });
    assert.deepEqual([r.sessoes, r.comPlano, r.planos], [1, 1, 3]);
    assert.deepEqual(await historico(), [[3, 'current', '0/1'], [2, 'abandoned', '0/2'], [1, 'completed', '2/2']]);
    const d = await decisoes.listDecisions({ sessionId: S });
    assert.equal(d.items.filter((x) => x.origin === 'question').length, 2);
    assert.equal(r.decisoes, d.items.length);

    // De novo: nada duplica.
    const outra = await reprocessarHistorico({ storage: store, decisoes, root });
    assert.equal(outra.decisoes, 0);
    assert.equal((await store.listPlanRecords(S)).length, 3);
  });

  test('marca feito uma vez por banco (migração 6, aditiva)', () => {
    assert.equal(store.isReprocessed('x'), false);
    store.markReprocessed('x', at(1));
    assert.equal(store.isReprocessed('x'), true);
    const m = MIGRATIONS.find((x) => x.sql.includes('CREATE TABLE reprocessamentos'))!;
    assert.doesNotMatch(m.sql, /\b(DROP|ALTER)\b/);
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((x) => x.version < m.version));
    assert.deepEqual(migrate(db, MIGRATIONS.filter((x) => x.version <= m.version)), [m.version]);
    db.close();
  });
});

describe('captura das decisões na importação', () => {
  test('a sessão importada com resposta ao AskUserQuestion ganha as decisões', async () => {
    const { root } = projeto([
      tx.toolUse(o('a1', 1), 'toolu_ask', 'AskUserQuestion', ASK_INPUT),
      tx.toolResult(o('a2', 2), 'toolu_ask', 'Your questions have been answered', { toolUseResult: { questions: ASK_INPUT.questions, answers: ASK_ANSWERS } }),
    ]);
    let criadas = 0;
    await importHistory({ storage: store, root, onSession: async (s) => void (criadas += await capturarDoTranscript(decisoes, s)) });
    assert.equal(criadas, 2);
    assert.equal((await decisoes.listDecisions({ sessionId: S })).items.length, 2);
  });

  test('sem evento que traga decisão, o transcript nem é lido', async () => {
    const { arquivo } = projeto([]);
    const lidas = await capturarDoTranscript(decisoes, {
      sessionId: S,
      transcriptPath: arquivo,
      added: [{ id: 'e1', sessionId: S, agentId: null, type: 'ToolUse', toolName: 'Bash', summary: null, data: null, createdAt: at(1) }],
    });
    assert.equal(lidas, 0);
  });
});

describe('ruído nas decisões (#131)', () => {
  const DISPENSADA = '[User dismissed — do not proceed, wait for next instruction]';

  test('pergunta fechada sem resposta não vira decisão', async () => {
    const { root } = projeto([
      tx.toolUse(o('a1', 1), 'toolu_ask', 'AskUserQuestion', ASK_INPUT),
      tx.toolResult(o('a2', 2), 'toolu_ask', 'dismissed', { toolUseResult: { questions: ASK_INPUT.questions, answers: { [ASK_INPUT.questions[0].question]: DISPENSADA } } }),
    ]);
    let criadas = 0;
    await importHistory({ storage: store, root, onSession: async (s) => void (criadas += await capturarDoTranscript(decisoes, s)) });
    assert.equal(criadas, 0);
  });

  test('a limpeza tira das listas a dispensada e a "correção" que é conversa, e encurta a que fica', async () => {
    await store.putSession({ id: S, name: null, status: 'active', cwd: '/repo/app', model: null, source: 'startup', startedAt: at(0), endedAt: null, awaitingInputSince: null, awaitingReason: null, updatedAt: at(0), accountId: null, accountSource: null, metadata: {} });
    const base = { sessionId: S, repo: '/repo/app', branch: 'main', alternatives: [], decidedBy: 'user' as const, decidedAt: at(1) };
    const reg = async (sourceKey: string, extra: object) => (await registerDecision(decisoes, { ...base, sourceKey, topic: null, context: null, choice: 'x', origin: 'question', inferred: false, ...extra } as never, at(1))).decision;
    const dispensada = await reg('q1', { choice: DISPENSADA, topic: 'question:qual banco' });
    const conversa = await reg('prompt:p1', { origin: 'correction', inferred: true, state: 'to_confirm', context: 'Vou subir o Postgres.', choice: 'Não sei se é possível, mas seria legal, né? A gente marcar os planos já executados' });
    const real = await reg('prompt:p2', { origin: 'correction', inferred: true, state: 'to_confirm', context: 'Sigo com o merge e crio a tag?', choice: 'Não, não solta a tag ainda. Espera o review do time.' });
    const tocada = await reg('prompt:p3', { origin: 'correction', inferred: true, state: 'to_confirm', context: 'Vou subir o Postgres.', choice: 'Não, calma.', metadata: { panel: { action: 'dismiss' } } });

    const r = await limparDecisoes(store, decisoes, at(5));
    assert.deepEqual(r, { ruido: 2, encurtadas: 1 });
    assert.equal((await decisoes.getDecision(dispensada.id))?.state, 'dismissed');
    assert.equal((await decisoes.getDecision(dispensada.id))?.metadata.noise, 'pergunta fechada sem resposta');
    assert.equal((await decisoes.getDecision(conversa.id))?.state, 'dismissed');
    const ficou = (await decisoes.getDecision(real.id))!;
    assert.equal(ficou.state, 'to_confirm');
    assert.equal(ficou.choice, 'Não, não solta a tag ainda.');
    assert.equal(ficou.metadata.text, 'Não, não solta a tag ainda. Espera o review do time.');
    assert.equal((await decisoes.getDecision(tocada.id))?.state, 'to_confirm', 'a que a pessoa já mexeu fica');
    assert.deepEqual(await limparDecisoes(store, decisoes, at(6)), { ruido: 0, encurtadas: 0 });
  });
});

describe('full message text (Conversa)', () => {
  test('fills data.text of the prompts and messages imported before it existed, subagents included', async () => {
    const { root } = projeto([tx.prompt(o('u1', 1), 'Primeira linha\n\nsegunda linha'), tx.say(o('a1', 2), 'Resposta\n- um\n- dois')]);
    const dir = join(root, '-repo-app', S, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-x1.jsonl'), jsonl([tx.say({ ...o('s1', 3), agentId: 'x1' }, 'Do subagente\nfim')]).map((l) => `${l}\n`).join(''));
    await importHistory({ storage: store, root });
    // As an old import left them: no data.text.
    store.db.exec(`UPDATE events SET data = json_remove(data, '$.text')`);
    const texts = async () => (await store.listEvents(S)).items.filter((e) => e.type !== 'ToolUse').map((e) => (e.data as { text?: string } | null)?.text ?? null);
    assert.deepEqual(await texts(), [null, null, null]);

    const r = await reprocessMessageText({ storage: store, root });
    assert.deepEqual(r, { sessions: 1, messages: 3 });
    assert.deepEqual(await texts(), ['Primeira linha\n\nsegunda linha', 'Resposta\n- um\n- dois', 'Do subagente\nfim']);
  });
});
