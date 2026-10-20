// CA4: a new decision on the same topic replaces the previous one, with the chain in both directions.
// CA5: decisions go through /clear, compaction and into child sessions.
// CA2: a decision to confirm only counts after it is confirmed.

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
} from '../../src/decisions/registry.ts';
import { InvalidModelError } from '../../src/model.ts';
import { at, draft, openCtx, type Ctx } from './helpers.ts';

describe('decisions: registry, chain and family', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await openCtx();
  });
  afterEach(async () => {
    await ctx.storage.close();
  });
  const reg = (over: Parameters<typeof draft>[0], now = at(60)) => registerDecision(ctx.decisions, draft(over), now);
  const get = async (id: string) => (await ctx.decisions.getDecision(id))!;

  test('registering the same source twice does not duplicate and only fills in what was missing', async () => {
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

  test('CA4: the new one on the same topic replaces the previous one, and the chain walks both ways', async () => {
    const d1 = (await reg({ choice: 'Postgres no Docker', decidedAt: at(1) })).decision;
    const other = (await reg({ topic: 'permissao:bash npm test', choice: 'Permitir Bash: npm test', decidedAt: at(2) })).decision;
    const d2 = (await reg({ choice: 'SQLite em memória', origin: 'correcao', decidedAt: at(3) })).decision;
    const d3 = (await reg({ choice: 'SQLite em arquivo', decidedAt: at(4) })).decision;

    assert.equal(decisionLabel(d3), 'D4');
    const [v1, v2, v3, vo] = await Promise.all([get(d1.id), get(d2.id), get(d3.id), get(other.id)]);
    assert.equal(v1.state, 'substituida');
    assert.equal(v1.supersededBy, d2.id);
    assert.equal(v2.state, 'substituida');
    assert.equal(v2.supersedes, d1.id);
    assert.equal(v2.supersededBy, d3.id);
    assert.equal(v3.state, 'vigente');
    assert.equal(v3.supersedes, d2.id);
    assert.equal(vo.state, 'vigente', 'another topic does not join the chain');

    const ids = (l: { id: string }[]) => l.map((d) => d.id);
    const expected = [d1.id, d2.id, d3.id];
    assert.deepEqual(ids(await decisionChain(ctx.decisions, d1.id)), expected);
    assert.deepEqual(ids(await decisionChain(ctx.decisions, d2.id)), expected);
    assert.deepEqual(ids(await decisionChain(ctx.decisions, d3.id)), expected);
  });

  test('CA4: an out-of-order capture lands in the right place of the chain', async () => {
    const newer = (await reg({ choice: 'SQLite', decidedAt: at(10) })).decision;
    const older = (await reg({ choice: 'Postgres', decidedAt: at(1) })).decision;
    assert.equal((await get(newer.id)).state, 'vigente');
    assert.equal((await get(older.id)).state, 'substituida');
    assert.equal((await get(older.id)).supersededBy, newer.id);
  });

  test('without a topic, nothing replaces anything', async () => {
    const a = (await reg({ topic: null, decidedAt: at(1) })).decision;
    const b = (await reg({ topic: null, decidedAt: at(2) })).decision;
    assert.equal((await get(a.id)).state, 'vigente');
    assert.equal((await get(b.id)).state, 'vigente');
  });

  test('CA2: to confirm neither replaces nor counts; once confirmed, it joins the chain', async () => {
    const current = (await reg({ choice: 'Postgres', decidedAt: at(1) })).decision;
    const suggested = (await reg({ origin: 'sugerida', decidedBy: 'agente', inferred: true, choice: 'SQLite', decidedAt: at(2) })).decision;
    assert.equal(suggested.state, 'a_confirmar');
    assert.equal((await get(current.id)).state, 'vigente');
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'sessao')).map((d) => d.id), [current.id]);

    const confirmed = await confirmDecision(ctx.decisions, suggested.id, at(3));
    assert.equal(confirmed.state, 'vigente');
    assert.equal(confirmed.supersedes, current.id);
    assert.equal((await get(current.id)).state, 'substituida');
    await assert.rejects(confirmDecision(ctx.decisions, suggested.id, at(4)), DecisionStateError);
  });

  test('discarding removes the suggestion from the lists and keeps it in the history', async () => {
    const s = (await reg({ origin: 'sugerida', decidedBy: 'agente', inferred: true })).decision;
    const d = await discardDecision(ctx.decisions, s.id, at(2));
    assert.equal(d.state, 'descartada');
    assert.equal((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'sessao')).length, 0);
    assert.ok(await ctx.decisions.getDecision(s.id));
    await assert.rejects(discardDecision(ctx.decisions, s.id, at(3)), DecisionStateError);
  });

  test('reverting brings back the previous one; the chain skips the reverted one', async () => {
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

  test('promoting keeps the record path', async () => {
    const d = (await reg({})).decision;
    const p = await markPromoted(ctx.decisions, d.id, 'docs/decisoes/0008-banco-nos-testes.md', at(2));
    assert.equal(p.promotedTo, 'docs/decisoes/0008-banco-nos-testes.md');
  });

  test('CA5: after /clear, the new linked session inherits the family\'s current decisions', async () => {
    const d1 = (await reg({ sessionId: 's1', choice: 'Kanban só leitura', topic: 'pergunta:kanban', decidedAt: at(1) })).decision;
    const local = (await reg({ sessionId: 's1', choice: 'Só nesta sessão', topic: null, scope: 'sessao', decidedAt: at(2) })).decision;
    await linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 's1', reason: 'clear', linkedAt: at(10) }, at(10));

    const inherited = await currentDecisionsFor(ctx.decisions, { sessionId: 's2' }, 'familia');
    assert.deepEqual(inherited.map((d) => d.id), [d1.id], 'session scope does not cross /clear');
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'familia')).map((d) => d.id).sort(), [d1.id, local.id].sort());

    // The new session decides the same topic again: it replaces the parent's, with the next number in the family.
    const d3 = (await reg({ sessionId: 's2', choice: 'Kanban com arrastar', topic: 'pergunta:kanban', decidedAt: at(11) })).decision;
    assert.equal(d3.familyId, 's1');
    assert.equal(d3.seq, 3);
    assert.equal((await get(d1.id)).supersededBy, d3.id);
  });

  test('CA5: compaction keeps the session, and the decisions stay in it', async () => {
    const d = (await reg({ sessionId: 's1', decidedAt: at(1) })).decision;
    // Depois do /compact o Claude Code segue com o mesmo session_id: nada a ligar.
    const after = await currentDecisionsFor(ctx.decisions, { sessionId: 's1' }, 'sessao');
    assert.deepEqual(after.map((x) => x.id), [d.id]);
  });

  test('CA5: the child and grandchildren join the family; what the child already decided comes along', async () => {
    const parent = (await reg({ sessionId: 'mae', topic: 'pergunta:a', decidedAt: at(1) })).decision;
    await linkSession(ctx.decisions, { sessionId: 'neta', parentSessionId: 'filha', reason: 'filha', linkedAt: at(2) }, at(2));
    const fromChild = (await reg({ sessionId: 'filha', topic: 'pergunta:a', choice: 'outra', decidedAt: at(3) })).decision;
    assert.equal(fromChild.familyId, 'filha');

    await linkSession(ctx.decisions, { sessionId: 'filha', parentSessionId: 'mae', reason: 'filha', linkedAt: at(4) }, at(4));
    const moved = await get(fromChild.id);
    assert.equal(moved.familyId, 'mae');
    assert.equal(moved.seq, 2);
    assert.equal((await get(parent.id)).supersededBy, fromChild.id, 'the chain is rebuilt in the new family');
    assert.equal((await ctx.decisions.getSessionLink('neta'))?.familyId, 'mae');
    assert.deepEqual((await currentDecisionsFor(ctx.decisions, { sessionId: 'neta' }, 'familia')).map((d) => d.id), [fromChild.id]);
  });

  test('linking again to the same family is idempotent; a cycle or a family change is rejected', async () => {
    const l = await linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 's1', reason: 'clear', linkedAt: at(1) }, at(1));
    assert.deepEqual(await linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 's1', reason: 'clear', linkedAt: at(9) }, at(9)), l);
    await assert.rejects(linkSession(ctx.decisions, { sessionId: 's1', parentSessionId: 's2', reason: 'clear', linkedAt: at(2) }, at(2)), InvalidModelError);
    await assert.rejects(linkSession(ctx.decisions, { sessionId: 's2', parentSessionId: 'sX', reason: 'resume', linkedAt: at(2) }, at(2)), InvalidModelError);
  });

  test('branch level adds the branch-scoped ones of other families on the same branch', async () => {
    const mine = (await reg({ sessionId: 's1', topic: 'a', decidedAt: at(1) })).decision;
    const branchScoped = (await reg({ sessionId: 'sX', topic: 'b', scope: 'branch', decidedAt: at(2) })).decision;
    await reg({ sessionId: 'sY', topic: 'c', scope: 'familia', decidedAt: at(3) });
    await reg({ sessionId: 'sZ', topic: 'd', scope: 'branch', branch: 'main', decidedAt: at(4) });
    const r = await currentDecisionsFor(ctx.decisions, { sessionId: 's1', branch: 'feat/42-kanban', repo: '/repo/app' }, 'branch');
    assert.deepEqual(r.map((d) => d.id), [branchScoped.id, mine.id]);
  });
});
