// CA3: each decision keeps context, choice, alternatives, who decided, origin, link, scope and state.
// And the port queries by session, family and branch, paginating by cursor.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate, schemaVersion } from '../../src/adapters/sqlite/migrations.ts';
import { DECISION_STATES, type Decision } from '../../src/decisions/model.ts';
import { registerDecision } from '../../src/decisions/registry.ts';
import { InvalidModelError } from '../../src/model.ts';
import { at, draft, openCtx, type Ctx } from './helpers.ts';

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'dec:1',
    sourceKey: 'tool:toolu_1:q0',
    sessionId: 's1',
    agentId: 's1:main',
    familyId: 's1',
    seq: 1,
    repo: '/repo/app',
    branch: 'feat/42-kanban',
    topic: 'question:banco',
    context: 'Qual banco usar nos testes?',
    choice: 'SQLite em memória',
    alternatives: ['Postgres no Docker'],
    decidedBy: 'user',
    origin: 'question',
    inferred: false,
    state: 'current',
    scope: 'family',
    supersedes: null,
    supersededBy: null,
    message: { uuid: 'u-1', toolUseId: 'toolu_1', transcriptPath: '/home/dev/.claude/projects/-repo-app/s1.jsonl' },
    textReleased: false,
    promotedTo: null,
    decidedAt: at(1),
    updatedAt: at(1),
    metadata: { header: 'Banco' },
    ...over,
  };
}

describe('decisions: model and port', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await openCtx();
  });
  afterEach(async () => {
    await ctx.storage.close();
  });

  test('the decisions migration is additive', () => {
    const m = MIGRATIONS.find((x) => x.sql.includes('CREATE TABLE decisions'));
    assert.ok(m);
    assert.equal(m.version, 4);
    assert.equal(ctx.storage.schemaVersion, MIGRATIONS.at(-1)!.version);
    assert.doesNotMatch(m.sql, /\b(DROP|ALTER)\b/);
  });

  test('a version 3 database gains the decisions and session_links tables', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 3));
    assert.equal(schemaVersion(db), 3);
    assert.deepEqual(migrate(db, MIGRATIONS.filter((m) => m.version <= 4)), [4]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    assert.ok(tables.includes('decisions') && tables.includes('session_links'));
    db.close();
  });

  test('CA3: writes and reads the whole decision', async () => {
    const d = decision();
    await ctx.decisions.putDecision(d);
    assert.deepEqual(await ctx.decisions.getDecision('dec:1'), d);
  });

  test('CA3: accepts the wireframe states and discard', async () => {
    for (const [i, state] of DECISION_STATES.entries()) {
      const d = decision({ id: `dec:${i}`, state, supersededBy: state === 'superseded' ? 'dec:x' : null });
      await ctx.decisions.putDecision(d);
      assert.equal((await ctx.decisions.getDecision(d.id))?.state, state);
    }
  });

  test('rejects an inconsistent decision', async () => {
    const bad: Partial<Decision>[] = [
      { choice: '' },
      { origin: 'chute' as never },
      { scope: 'mundo' as never },
      { state: 'superseded', supersededBy: null },
      { state: 'current', supersededBy: 'dec:2' },
      { supersedes: 'dec:1' },
      { origin: 'suggested', decidedBy: 'user' },
      { decidedAt: '2026-11-02 12:00' },
      { seq: 0 },
      { alternatives: [''] },
    ];
    for (const over of bad) {
      await assert.rejects(ctx.decisions.putDecision(decision(over)), InvalidModelError, JSON.stringify(over));
    }
  });

  test('queries by session, family and branch, newest first', async () => {
    await ctx.decisions.putDecision(decision({ id: 'a', decidedAt: at(1) }));
    await ctx.decisions.putDecision(decision({ id: 'b', sessionId: 's2', decidedAt: at(2), seq: 2 }));
    await ctx.decisions.putDecision(decision({ id: 'c', sessionId: 's3', familyId: 's3', decidedAt: at(3) }));
    await ctx.decisions.putDecision(decision({ id: 'd', sessionId: 's4', familyId: 's4', repo: '/repo/outro', decidedAt: at(4) }));
    await ctx.decisions.putDecision(decision({ id: 'e', sessionId: 's5', familyId: 's5', branch: 'main', decidedAt: at(5) }));

    const ids = async (q: Parameters<Ctx['decisions']['listDecisions']>[0]) =>
      (await ctx.decisions.listDecisions(q)).items.map((d) => d.id);
    assert.deepEqual(await ids({ sessionId: 's1' }), ['a']);
    assert.deepEqual(await ids({ familyId: 's1' }), ['b', 'a']);
    assert.deepEqual(await ids({ branch: 'feat/42-kanban' }), ['d', 'c', 'b', 'a']);
    assert.deepEqual(await ids({ branch: 'feat/42-kanban', repo: '/repo/app' }), ['c', 'b', 'a']);
    assert.deepEqual(await ids({ branch: 'feat/42-kanban', states: [] }), []);
  });

  test('filters by state and paginates by cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.decisions.putDecision(decision({ id: `d${i}`, seq: i + 1, decidedAt: at(i), state: i % 2 ? 'to_confirm' : 'current' }));
    }
    const p1 = await ctx.decisions.listDecisions({ familyId: 's1', limit: 2 });
    assert.deepEqual(p1.items.map((d) => d.id), ['d4', 'd3']);
    const p2 = await ctx.decisions.listDecisions({ familyId: 's1', limit: 2, cursor: p1.nextCursor });
    const p3 = await ctx.decisions.listDecisions({ familyId: 's1', limit: 2, cursor: p2.nextCursor });
    assert.deepEqual([...p2.items, ...p3.items].map((d) => d.id), ['d2', 'd1', 'd0']);
    assert.equal(p3.nextCursor, null);
    const toConfirm = await ctx.decisions.listDecisions({ familyId: 's1', states: ['to_confirm'] });
    assert.deepEqual(toConfirm.items.map((d) => d.id), ['d3', 'd1']);
    await assert.rejects(ctx.decisions.listDecisions({ familyId: 's1', cursor: 'lixo' }), RangeError);
  });

  test('lastSeq and session links', async () => {
    assert.equal(await ctx.decisions.lastSeq('s1'), 0);
    await ctx.decisions.putDecision(decision({ seq: 7 }));
    assert.equal(await ctx.decisions.lastSeq('s1'), 7);
    const link = { sessionId: 's2', parentSessionId: 's1', familyId: 's1', reason: 'clear' as const, linkedAt: at(5) };
    await ctx.decisions.putSessionLink(link);
    assert.deepEqual(await ctx.decisions.getSessionLink('s2'), link);
    assert.deepEqual(await ctx.decisions.listSessionLinks('s1'), [link]);
    await assert.rejects(ctx.decisions.putSessionLink({ ...link, parentSessionId: 's2' }), InvalidModelError);
  });

  test('CA3: the registry fills in family, number, default scope and the message link', async () => {
    const { decision: d } = await registerDecision(
      ctx.decisions,
      draft({ message: { uuid: 'u-9', toolUseId: 'toolu_9' } }),
      at(2),
    );
    assert.equal(d.familyId, 's1');
    assert.equal(d.seq, 1);
    assert.equal(d.scope, 'family');
    assert.equal(d.state, 'current');
    assert.deepEqual(d.message, { uuid: 'u-9', toolUseId: 'toolu_9', transcriptPath: null });
    assert.equal(d.decidedBy, 'user');
    assert.deepEqual(d.alternatives, ['SQLite em memória']);
  });
});
