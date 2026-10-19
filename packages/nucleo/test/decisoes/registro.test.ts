// CA4: decisão nova sobre o mesmo assunto substitui a anterior, com a cadeia nos dois sentidos.
// CA5: as decisões passam pelo /clear, pela compactação e para as sessões filhas.
// CA2: a decisão a confirmar só vale depois de confirmada.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  DecisionStateError,
  confirmDecision,
  currentDecisionsFor,
  decisionChain,
  decisionLabel,
  discardDecision,
  linkSession,
  markPromoted,
  registerDecision,
  revertDecision,
} from '../../src/decisoes/registro.ts';
import { InvalidModelError } from '../../src/model.ts';
import { at, draft, openCtx, type Ctx } from './helpers.ts';

describe('decisões: registro, cadeia e família', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await openCtx();
  });
  afterEach(async () => {
    await ctx.storage.close();
  });
  const reg = (over: Parameters<typeof draft>[0], now = at(60)) => registerDecision(ctx.decisions, draft(over), now);
  const get = async (id: string) => (await ctx.decisions.getDecision(id))!;

  test('registrar a mesma origem duas vezes não duplica e só completa o que faltava', async () => {
    const a = await reg({ sourceKey: 'tool:t1:q0', branch: null, message: { toolUseId: 't1' } });
    const b = await reg({ sourceKey: 'tool:t1:q0', branch: 'feat/x', message: { uuid: 'u-1', transcriptPath: '/t.jsonl' } });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.decision.id, a.decision.id);
    assert.equal(b.decision.seq, 1);
    assert.equal(b.decision.branch, 'feat/x');
    assert.deepEqual(b.decision.message, { uuid: 'u-1', toolUseId: 't1', transcriptPath: '/t.jsonl' });
    assert.equal((await ctx.decisions.listDecisions({ sessionId: 's1' })).items.length, 1);
  });

  test('CA4: a nova sobre o mesmo assunto substitui a anterior, e a cadeia anda nos dois sentidos', async () => {
    const d1 = (await reg({ choice: 'Postgres no Docker', decidedAt: at(1) })).decision;
    const outro = (await reg({ topic: 'permissao:bash npm test', choice: 'Permitir Bash: npm test', decidedAt: at(2) })).decision;
    const d2 = (await reg({ choice: 'SQLite em memória', origin: 'correcao', decidedAt: at(3) })).decision;
    const d3 = (await reg({ choice: 'SQLite em arquivo', decidedAt: at(4) })).decision;

    assert.equal(decisionLabel(d3), 'D4');
    const [v1, v2, v3, vo] = await Promise.all([get(d1.id), get(d2.id), get(d3.id), get(outro.id)]);
    assert.equal(v1.state, 'substituida');
    assert.equal(v1.supersededBy, d2.id);
    assert.equal(v2.state, 'substituida');
    assert.equal(v2.supersedes, d1.id);
    assert.equal(v2.supersededBy, d3.id);
    assert.equal(v3.state, 'vigente');
    assert.equal(v3.supersedes, d2.id);
    assert.equal(vo.state, 'vigente', 'outro assunto não entra na cadeia');

    const ids = (l: { id: string }[]) => l.map((d) => d.id);
    const esperado = [d1.id, d2.id, d3.id];
    assert.deepEqual(ids(await decisionChain(ctx.decisions, d1.id)), esperado);
    assert.deepEqual(ids(await decisionChain(ctx.decisions, d2.id)), esperado);
    assert.deepEqual(ids(await decisionChain(ctx.decisions, d3.id)), esperado);
  });

  test('CA4: captura fora de ordem entra no lugar certo da cadeia', async () => {
    const nova = (await reg({ choice: 'SQLite', decidedAt: at(10) })).decision;
    const velha = (await reg({ choice: 'Postgres', decidedAt: at(1) })).decision;
    assert.equal((await get(nova.id)).state, 'vigente');
    assert.equal((await get(velha.id)).state, 'substituida');
    assert.equal((await get(velha.id)).supersededBy, nova.id);
  });

  test('sem assunto, nada substitui nada', async () => {
    const a = (await reg({ topic: null, decidedAt: at(1) })).decision;
    const b = (await reg({ topic: null, decidedAt: at(2) })).decision;
    assert.equal((await get(a.id)).state, 'vigente');
    assert.equal((await get(b.id)).state, 'vigente');
  });

  test('CA2: a confirmar não substitui nem vale; confirmada, entra na cadeia', async () => {
    const vigente = (await reg({ choice: 'Postgres', decidedAt: at(1) })).decision;
    const sugerida = (await reg({ origin: 'sugerida', decidedBy: 'agente', inferred: true, choice: 'SQLite', decidedAt: at(2) })).decision;
    assert.equal(sugerida.state, 'a_confirmar');
    assert.equal((await get(vigente.id)).state, 'vigente');
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'sessao')).map((d) => d.id), [vigente.id]);

    const confirmada = await confirmDecision(ctx.decisions, sugerida.id, at(3));
    assert.equal(confirmada.state, 'vigente');
    assert.equal(confirmada.supersedes, vigente.id);
    assert.equal((await get(vigente.id)).state, 'substituida');
    await assert.rejects(confirmDecision(ctx.decisions, sugerida.id, at(4)), DecisionStateError);
  });

  test('descartar tira a sugestão das listas e guarda no histórico', async () => {
    const s = (await reg({ origin: 'sugerida', decidedBy: 'agente', inferred: true })).decision;
    const d = await discardDecision(ctx.decisions, s.id, at(2));
    assert.equal(d.state, 'descartada');
    assert.equal((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'sessao')).length, 0);
    assert.ok(await ctx.decisions.getDecision(s.id));
    await assert.rejects(discardDecision(ctx.decisions, s.id, at(3)), DecisionStateError);
  });

  test('reverter devolve a anterior; a cadeia pula a revertida', async () => {
    const d1 = (await reg({ choice: 'Postgres', decidedAt: at(1) })).decision;
    const d2 = (await reg({ choice: 'SQLite', decidedAt: at(2) })).decision;
    const r = await revertDecision(ctx.decisions, d2.id, at(3));
    assert.equal(r.state, 'revertida');
    assert.equal(r.supersedes, null);
    const v1 = await get(d1.id);
    assert.equal(v1.state, 'vigente');
    assert.equal(v1.supersededBy, null);
    await assert.rejects(revertDecision(ctx.decisions, d1.id + 'x', at(4)), DecisionStateError);
    await assert.rejects(revertDecision(ctx.decisions, d2.id, at(4)), DecisionStateError);
  });

  test('promover guarda o caminho do registro', async () => {
    const d = (await reg({})).decision;
    const p = await markPromoted(ctx.decisions, d.id, 'docs/decisoes/0008-banco-nos-testes.md', at(2));
    assert.equal(p.promotedTo, 'docs/decisoes/0008-banco-nos-testes.md');
  });

  test('CA5: depois de /clear, a sessão nova ligada herda as vigentes da família', async () => {
    const d1 = (await reg({ sessionId: 's1', choice: 'Kanban só leitura', topic: 'pergunta:kanban', decidedAt: at(1) })).decision;
    const local = (await reg({ sessionId: 's1', choice: 'Só nesta sessão', topic: null, scope: 'sessao', decidedAt: at(2) })).decision;
    await linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 's1', reason: 'clear', linkedAt: at(10) }, at(10));

    const herdadas = await currentDecisionsFor(ctx.decisions, { sessionId: 's2' }, 'familia');
    assert.deepEqual(herdadas.map((d) => d.id), [d1.id], 'escopo sessão não atravessa o /clear');
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'familia')).map((d) => d.id).sort(), [d1.id, local.id].sort());

    // A sessão nova decide de novo o mesmo assunto: substitui a da mãe, com número seguinte na família.
    const d3 = (await reg({ sessionId: 's2', choice: 'Kanban com arrastar', topic: 'pergunta:kanban', decidedAt: at(11) })).decision;
    assert.equal(d3.familyId, 's1');
    assert.equal(d3.seq, 3);
    assert.equal((await get(d1.id)).supersededBy, d3.id);
  });

  test('CA5: a compactação mantém a sessão, e as decisões continuam nela', async () => {
    const d = (await reg({ sessionId: 's1', decidedAt: at(1) })).decision;
    // Depois do /compact o Claude Code segue com o mesmo session_id: nada a ligar.
    const after = await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'sessao');
    assert.deepEqual(after.map((x) => x.id), [d.id]);
  });

  test('CA5: a filha e as netas entram na família; o que a filha já decidiu vai junto', async () => {
    const mae = (await reg({ sessionId: 'mae', topic: 'pergunta:a', decidedAt: at(1) })).decision;
    await linkSession(ctx.decisions, { sessionId: 'neta', parentSessionId: 'filha', reason: 'filha', linkedAt: at(2) }, at(2));
    const daFilha = (await reg({ sessionId: 'filha', topic: 'pergunta:a', choice: 'outra', decidedAt: at(3) })).decision;
    assert.equal(daFilha.familyId, 'filha');

    await linkSession(ctx.decisions, { sessionId: 'filha', parentSessionId: 'mae', reason: 'filha', linkedAt: at(4) }, at(4));
    const movida = await get(daFilha.id);
    assert.equal(movida.familyId, 'mae');
    assert.equal(movida.seq, 2);
    assert.equal((await get(mae.id)).supersededBy, daFilha.id, 'a cadeia se refaz na família nova');
    assert.equal((await ctx.decisions.getSessionLink('neta'))?.familyId, 'mae');
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 'neta' }, 'familia')).map((d) => d.id), [daFilha.id]);
  });

  test('ligar de novo à mesma família é idempotente; ciclo e troca de família são recusados', async () => {
    const l = await linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 's1', reason: 'clear', linkedAt: at(1) }, at(1));
    assert.deepEqual(await linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 's1', reason: 'clear', linkedAt: at(9) }, at(9)), l);
    await assert.rejects(linkSession(ctx.decisions, { sessionId: 's1', parentSessionId: 's2', reason: 'clear', linkedAt: at(2) }, at(2)), InvalidModelError);
    await assert.rejects(linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 'sX', reason: 'resume', linkedAt: at(2) }, at(2)), InvalidModelError);
  });

  test('nível branch soma as de escopo branch de outras famílias no mesmo branch', async () => {
    const minha = (await reg({ sessionId: 's1', topic: 'a', decidedAt: at(1) })).decision;
    const deBranch = (await reg({ sessionId: 'sX', topic: 'b', scope: 'branch', decidedAt: at(2) })).decision;
    await reg({ sessionId: 'sY', topic: 'c', scope: 'familia', decidedAt: at(3) });
    await reg({ sessionId: 'sZ', topic: 'd', scope: 'branch', branch: 'main', decidedAt: at(4) });
    const r = await currentDecisionsFor(ctx.decisions, { sessionId: 's1', branch: 'feat/42-kanban', repo: '/repo/app' }, 'branch');
    assert.deepEqual(r.map((d) => d.id), [deBranch.id, minha.id]);
  });
});
