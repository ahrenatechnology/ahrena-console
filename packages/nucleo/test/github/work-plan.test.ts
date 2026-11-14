/*
 * #507 the planning run of the work board: the planning-only prompt, how a run settles (planning, plan
 * or failure) and the SQLite record (migration 17). Scenario tokens are `#507/AC-n`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MIGRATIONS } from '../../src/adapters/sqlite/migrations.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  isPlanRunActive,
  PLAN_FAILURE_TEXT,
  PLAN_SESSION_WINDOW_MS,
  planningKeyOfPrompt,
  planningOfRun,
  planningPrompt,
  settlePlanRun,
  type PlanRun,
} from '../../src/github/work-plan.ts';
import { SqliteWorkPlanRuns } from '../../src/github/work-plan-runs.ts';

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const run = (over: Partial<PlanRun> = {}): PlanRun => ({
  key: 'acme/app#412',
  target: 'terminal',
  startedAt: iso(T0),
  replan: false,
  sessionId: null,
  outcome: 'running',
  failure: null,
  finishedAt: null,
  ...over,
});

describe('#507/AC-1 the planning-only prompt', () => {
  test('#507/AC-1 Given an issue, Then the prompt names it, the planning-changes skill, Plan sub-issues as the output, and no code or pull request', () => {
    const p = planningPrompt({ repo: 'acme/app', number: 412 });
    assert.match(p, /acme\/app#412/);
    assert.match(p, /`planning-changes`/);
    assert.match(p, /Athena/);
    assert.match(p, /planning only/i);
    assert.match(p, /Plan sub-issues/);
    assert.match(p, /no code/i);
    assert.match(p, /no pull request/i);
    assert.match(p, /gh issue view 412 --repo acme\/app/);
    assert.ok(p.length < 2000, 'well under the Desktop cap');
  });

  test('#507/AC-1 the first line is the marker the board finds the planning session by', () => {
    const p = planningPrompt({ repo: 'Acme/App', number: 412 });
    assert.equal(planningKeyOfPrompt(p), 'Acme/App#412');
    assert.equal(planningKeyOfPrompt('Please look at acme/app#412'), null);
    assert.equal(planningKeyOfPrompt(`something\n${p}`), null);
  });
});

describe('#507/AC-2 replan', () => {
  test('#507/AC-2 Given a replan, Then the prompt lists the current steps by number, to be replaced', () => {
    const p = planningPrompt({ repo: 'acme/app', number: 412, replaceSteps: [601, 602] });
    assert.match(p, /#601, #602/);
    assert.match(p, /replace/i);
    assert.doesNotMatch(planningPrompt({ repo: 'acme/app', number: 412 }), /replace/i);
  });

  test('#507/AC-2 a long plan lists the first 50 steps and says how many more', () => {
    const steps = Array.from({ length: 53 }, (_, i) => 1000 + i);
    const p = planningPrompt({ repo: 'acme/app', number: 412, replaceSteps: steps });
    assert.match(p, /#1049\b/);
    assert.doesNotMatch(p, /#1050\b/);
    assert.match(p, /3 more/);
  });
});

describe('#507/AC-6 the prompt carries no untrusted text', () => {
  test('#507/AC-6 a repo or a number that is not a plain name is refused, never quoted', () => {
    for (const repo of ['acme/app; touch x', 'acme/app$(touch /tmp/x)', 'acme/`id`', "a'b/c", 'a/b\nc', 'acme', 'a.b/app', '../app']) {
      assert.throws(() => planningPrompt({ repo, number: 1 }), RangeError, repo);
    }
    for (const number of [0, -1, 1.5, 2147483648, Number.NaN]) assert.throws(() => planningPrompt({ repo: 'acme/app', number }), RangeError, String(number));
    assert.throws(() => planningPrompt({ repo: 'acme/app', number: 1, replaceSteps: [1, -2] }), RangeError);
  });

  test('#507/AC-6 the prompt is built from the validated repo and numbers only', () => {
    const p = planningPrompt({ repo: 'acme/app-1.x_y', number: 7, replaceSteps: [8, 9] });
    assert.match(p, /^[\x20-\x7e\n]+$/, 'printable ASCII and newlines');
    assert.doesNotMatch(p, /[$|&<>\\]/);
  });
});

describe('#507/AC-3 #507/AC-4 how a run settles', () => {
  const planning = (r: PlanRun) => planningOfRun(r);

  test('#507/AC-3 Given a run and its live session and no plan, Then it keeps planning and remembers the session', () => {
    const r = settlePlanRun(run(), { live: [{ sessionId: 's1', since: iso(T0 + 5_000) }], steps: 0, now: T0 + 60_000 });
    assert.equal(r.outcome, 'running');
    assert.equal(r.sessionId, 's1');
    assert.deepEqual(planning(r), { state: 'running' });
  });

  test('#507/AC-3 a planning session older than the run is not the run\'s session', () => {
    const r = settlePlanRun(run(), { live: [{ sessionId: 'old', since: iso(T0 - 60_000) }], steps: 0, now: T0 + 60_000 });
    assert.equal(r.sessionId, null);
    assert.equal(r.outcome, 'running');
  });

  test('#507/AC-3 Given Plan sub-issues exist, Then the run is done and the card shows no planning state', () => {
    const r = settlePlanRun(run({ sessionId: 's1' }), { live: [{ sessionId: 's1', since: iso(T0 + 5_000) }], steps: 3, now: T0 + 90_000 });
    assert.equal(r.outcome, 'done');
    assert.equal(r.finishedAt, iso(T0 + 90_000));
    assert.equal(planning(r), null);
  });

  test('#507/AC-4 Given the session ended and there is no plan, Then the run failed with its reason, pt-BR on screen', () => {
    const r = settlePlanRun(run({ sessionId: 's1' }), { live: [], steps: 0, now: T0 + 120_000 });
    assert.equal(r.outcome, 'failed');
    assert.equal(r.failure, 'session-ended');
    assert.deepEqual(planning(r), { state: 'failed', reason: 'A sessão de planejamento terminou sem plano' });
    assert.equal(PLAN_FAILURE_TEXT['session-ended'], 'A sessão de planejamento terminou sem plano');
  });

  test('#507/AC-4 Given no session ever showed up within the window, Then the run failed with its own reason', () => {
    const early = settlePlanRun(run(), { live: [], steps: 0, now: T0 + PLAN_SESSION_WINDOW_MS - 1 });
    assert.equal(early.outcome, 'running');
    const late = settlePlanRun(run(), { live: [], steps: 0, now: T0 + PLAN_SESSION_WINDOW_MS + 1 });
    assert.equal(late.outcome, 'failed');
    assert.equal(late.failure, 'session-not-started');
    assert.match((planning(late) as { reason: string }).reason, /não abriu/);
  });

  test('#507/AC-2 a replan already has steps: it is done only when its session ended', () => {
    const live = [{ sessionId: 's1', since: iso(T0 + 5_000) }];
    assert.equal(settlePlanRun(run({ replan: true, sessionId: 's1' }), { live, steps: 3, now: T0 + 60_000 }).outcome, 'running');
    assert.equal(settlePlanRun(run({ replan: true, sessionId: 's1' }), { live: [], steps: 3, now: T0 + 60_000 }).outcome, 'done');
    assert.equal(settlePlanRun(run({ replan: true, sessionId: 's1' }), { live: [], steps: 0, now: T0 + 60_000 }).outcome, 'failed');
  });

  test('a settled run stays as it is', () => {
    const failed = run({ outcome: 'failed', failure: 'session-ended', finishedAt: iso(T0 + 1) });
    assert.deepEqual(settlePlanRun(failed, { live: [], steps: 5, now: T0 + 10 * PLAN_SESSION_WINDOW_MS }), failed);
  });

  test('a run is active while running with its session seen, or inside the window', () => {
    assert.ok(isPlanRunActive(run(), T0 + 1000));
    assert.ok(!isPlanRunActive(run(), T0 + PLAN_SESSION_WINDOW_MS + 1));
    assert.ok(isPlanRunActive(run({ sessionId: 's1' }), T0 + 10 * PLAN_SESSION_WINDOW_MS));
    assert.ok(!isPlanRunActive(run({ outcome: 'failed', failure: 'session-ended' }), T0));
  });
});

describe('#507/AC-3 work_plan_runs', () => {
  test('migration 17 adds the table keyed by the issue key', () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 17));
    const storage = openSqliteStorage({ path: ':memory:' });
    const cols = (storage.db.prepare('PRAGMA table_info(work_plan_runs)').all() as { name: string; pk: number }[]).map((c) => [c.name, c.pk]);
    assert.deepEqual(cols, [['item_key', 1], ['target', 0], ['started_at', 0], ['replan', 0], ['session_id', 0], ['outcome', 0], ['failure', 0], ['finished_at', 0]]);
    storage.close();
  });

  test('a run is saved and read back, the key in lower case; a new run replaces the old one', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const runs = new SqliteWorkPlanRuns(storage.db);
    assert.equal(await runs.get('acme/app#412'), null);
    await runs.save(run({ key: 'Acme/App#412', replan: true }));
    assert.deepEqual(await runs.get('ACME/app#412'), run({ replan: true }));
    await runs.save(run({ target: 'desktop', sessionId: 's9' }));
    assert.deepEqual((await runs.all()).map((r) => [r.key, r.target, r.replan, r.sessionId]), [['acme/app#412', 'desktop', false, 's9']]);
    await runs.save(run({ outcome: 'failed', failure: 'session-ended', finishedAt: iso(T0 + 1) }));
    assert.equal((await runs.get('acme/app#412'))?.failure, 'session-ended');
    storage.close();
  });

  test('a database without the table is refused with a clear message', () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    storage.db.exec('DROP TABLE work_plan_runs');
    assert.throws(() => new SqliteWorkPlanRuns(storage.db), /work_plan_runs/);
    storage.close();
  });
});
