/*
 * #531 the execution run of the work board: the execution prompt, how a run settles (booting, linked,
 * expired), the limit, and the SQLite record (migration 18). Scenario tokens are `#531/AC-n`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MIGRATIONS } from '../../src/adapters/sqlite/migrations.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { planningKeyOfPrompt } from '../../src/github/work-plan.ts';
import {
  EXECUTION_LIMIT,
  EXECUTION_SESSION_WINDOW_MS,
  executionKeyOfPrompt,
  executionOfRun,
  executionPrompt,
  isExecutionRunActive,
  isOverExecutionLimit,
  settleExecutionRun,
  type ExecutionRun,
} from '../../src/github/work-execution.ts';
import { SqliteWorkExecutionRuns } from '../../src/github/work-execution-runs.ts';

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const run = (over: Partial<ExecutionRun> = {}): ExecutionRun => ({ key: 'acme/app#412', target: 'terminal', startedAt: iso(T0), state: 'booting', sessionId: null, finishedAt: null, ...over });

describe('#531/AC-1 the execution prompt', () => {
  test('#531/AC-1 Given an issue and its Plan steps, Then the prompt names the issue, asks Athena to execute the plan and lists the steps by number', () => {
    const p = executionPrompt({ repo: 'acme/app', number: 412, steps: [601, 602] });
    assert.match(p, /acme\/app#412/);
    assert.match(p, /Athena/);
    assert.match(p, /execute the plan/i);
    assert.match(p, /#601, #602/);
    assert.match(p, /gh issue view 412 --repo acme\/app/);
    assert.ok(p.length < 2000);
  });

  test('#531/AC-1 the first line is the marker the board finds the execution session by, and it is not a planning prompt', () => {
    const p = executionPrompt({ repo: 'Acme/App', number: 412, steps: [] });
    assert.equal(executionKeyOfPrompt(p), 'Acme/App#412');
    assert.equal(planningKeyOfPrompt(p), null, 'an execution prompt is never mistaken for a planning one');
    assert.equal(executionKeyOfPrompt('Please look at acme/app#412'), null);
    assert.equal(executionKeyOfPrompt(`x\n${p}`), null);
  });
});

describe('#531/AC-5 only validated identifiers enter the prompt', () => {
  test('#531/AC-5 a repo, number or step that is not plain throws before a prompt exists', () => {
    assert.throws(() => executionPrompt({ repo: 'acme/app; touch x', number: 1, steps: [] }), RangeError);
    assert.throws(() => executionPrompt({ repo: 'acme/app', number: 0, steps: [] }), RangeError);
    assert.throws(() => executionPrompt({ repo: 'acme/app', number: 1, steps: [1.5] }), RangeError);
    assert.throws(() => executionPrompt({ repo: 'acme/app', number: 1, steps: [Number.NaN] }), RangeError);
  });

  test('#531/AC-5 more steps than the cap are summarised by a count, not listed', () => {
    const steps = Array.from({ length: 80 }, (_, i) => i + 1);
    const p = executionPrompt({ repo: 'acme/app', number: 412, steps });
    assert.match(p, /and 30 more/);
    assert.ok(p.length < 4000);
  });
});

describe('#531/AC-3 the limit', () => {
  test('#531/AC-3 the default is 2 and the route is over it at 2 running cards unless forced', () => {
    assert.equal(EXECUTION_LIMIT, 2);
    assert.equal(isOverExecutionLimit(1, false), false);
    assert.equal(isOverExecutionLimit(2, false), true);
    assert.equal(isOverExecutionLimit(5, false), true);
    assert.equal(isOverExecutionLimit(5, true), false);
  });
});

describe('#531/AC-2 how a run settles', () => {
  test('#531/AC-2 Given no session yet, Then the run stays booting and the card shows the boot state', () => {
    const settled = settleExecutionRun(run(), { live: [], now: T0 + 1000 });
    assert.deepEqual(settled, run());
    assert.deepEqual(executionOfRun(settled), { state: 'booting' });
  });

  test('#531/AC-2 Given a live execution session that started after the run, Then the run links to it and the boot state clears', () => {
    const settled = settleExecutionRun(run(), { live: [{ sessionId: 's1', since: iso(T0 + 5000) }], now: T0 + 6000 });
    assert.equal(settled.state, 'linked');
    assert.equal(settled.sessionId, 's1');
    assert.equal(executionOfRun(settled), null);
  });

  test('#531/AC-2 a session older than the run is not the run\'s session', () => {
    const settled = settleExecutionRun(run(), { live: [{ sessionId: 'old', since: iso(T0 - 1000) }], now: T0 + 1000 });
    assert.equal(settled.state, 'booting');
  });

  test('#531/AC-2 Given no session within the window, Then the run expires and the card goes back', () => {
    const settled = settleExecutionRun(run(), { live: [], now: T0 + EXECUTION_SESSION_WINDOW_MS + 1 });
    assert.equal(settled.state, 'expired');
    assert.equal(settled.finishedAt, iso(T0 + EXECUTION_SESSION_WINDOW_MS + 1));
    assert.equal(executionOfRun(settled), null);
  });

  test('a linked or expired run is final; a booting run is active only inside the window', () => {
    const done = run({ state: 'linked', sessionId: 's1' });
    assert.equal(settleExecutionRun(done, { live: [], now: T0 + 99 * EXECUTION_SESSION_WINDOW_MS }), done);
    assert.ok(isExecutionRunActive(run(), T0 + EXECUTION_SESSION_WINDOW_MS));
    assert.ok(!isExecutionRunActive(run(), T0 + EXECUTION_SESSION_WINDOW_MS + 1));
    assert.ok(!isExecutionRunActive(done, T0));
  });
});

describe('#531/AC-2 work_execution_runs', () => {
  test('migration 18 adds the table keyed by the issue key', () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 18));
    const storage = openSqliteStorage({ path: ':memory:' });
    const cols = (storage.db.prepare('PRAGMA table_info(work_execution_runs)').all() as { name: string; pk: number }[]).map((c) => [c.name, c.pk]);
    assert.deepEqual(cols, [['item_key', 1], ['target', 0], ['started_at', 0], ['state', 0], ['session_id', 0], ['finished_at', 0]]);
    storage.close();
  });

  test('a run is saved and read back, the key in lower case; a new run replaces the old one', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const runs = new SqliteWorkExecutionRuns(storage.db);
    assert.equal(await runs.get('acme/app#412'), null);
    await runs.save(run({ key: 'Acme/App#412' }));
    assert.deepEqual(await runs.get('ACME/app#412'), run());
    await runs.save(run({ target: 'desktop', state: 'linked', sessionId: 's9' }));
    assert.deepEqual((await runs.all()).map((r) => [r.key, r.target, r.state, r.sessionId]), [['acme/app#412', 'desktop', 'linked', 's9']]);
    storage.close();
  });

  test('a database without the table is refused with a clear message', () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    storage.db.exec('DROP TABLE work_execution_runs');
    assert.throws(() => new SqliteWorkExecutionRuns(storage.db), /work_execution_runs/);
    storage.close();
  });
});
