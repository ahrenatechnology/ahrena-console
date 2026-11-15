// The sweep at the core's start against a real database, the audit file and the system adapters (#618/AC-3, layer 3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { join } from 'node:path';
import { openPermissionDeps } from '../../src/permissions/adapters/deps.ts';
import { PERMISSION_AUDIT_FILE } from '../../src/permissions/adapters/audit-file.ts';
import { SqlitePermissionRepository } from '../../src/permissions/adapters/sqlite-repository.ts';
import { PermissionRefusal } from '../../src/permissions/model.ts';
import { sweepOnStart } from '../../src/permissions/expire-due.ts';
import { waitForDecision } from '../../src/permissions/wait-for-decision.ts';
import { answerWith, openDatabase, openRequest, readJsonLines, tempDir } from './oltp-fixtures.ts';

describe('the sweep on start (#618/AC-3)', () => {
  test('#618/AC-3: every pending and answered request becomes core_restarted and is never delivered; terminal ones stay as they were', async () => {
    const dataDir = tempDir();
    const file = join(dataDir, 'core.sqlite');
    const before = new SqlitePermissionRepository(openDatabase(file));
    const pending = await openRequest({ id: 'pending', now: Date.now() });
    const answered = answerWith(await openRequest({ id: 'answered', now: Date.now() }), 'allow');
    const delivered = answerWith(await openRequest({ id: 'delivered', now: Date.now() }), 'allow');
    delivered.deliver(Date.now() + 1);
    const withdrawn = await openRequest({ id: 'withdrawn', now: Date.now() });
    withdrawn.withdraw(Date.now() + 1);
    for (const r of [pending, answered, delivered, withdrawn]) before.save(r);

    // The core starts again: a new connection, new deps.
    const deps = openPermissionDeps(openDatabase(file), dataDir);
    assert.deepEqual(sweepOnStart(deps).sort(), ['answered', 'pending']);

    const state = (id: string) => deps.repository.find('S1', id);
    assert.equal(state('pending')?.state, 'core_restarted');
    assert.equal(state('pending')?.settledBy, 'core_restart');
    assert.equal(state('answered')?.state, 'core_restarted');
    assert.equal(state('answered')?.decision, 'allow');
    assert.equal(state('delivered')?.state, 'delivered');
    assert.equal(state('delivered')?.settledAt, delivered.settledAt);
    assert.equal(state('withdrawn')?.state, 'withdrawn');
    assert.deepEqual(deps.repository.listOpen(), []);
    assert.deepEqual(sweepOnStart(deps), []);

    await assert.rejects(waitForDecision(deps, { sessionId: 'S1', requestId: 'answered', waitMs: 0 }), (e) => e instanceof PermissionRefusal && e.code === 'gone');
    await assert.rejects(waitForDecision(deps, { sessionId: 'S1', requestId: 'pending', waitMs: 0 }), (e) => e instanceof PermissionRefusal && e.code === 'gone');
  });

  test('the sweep is audited as closed by core_restart, with no reason and no call in the file', async () => {
    const dataDir = tempDir();
    const file = join(dataDir, 'core.sqlite');
    new SqlitePermissionRepository(openDatabase(file)).save(answerWith(await openRequest({ now: Date.now() }), 'deny', 'plain words hunter2pw'));
    sweepOnStart(openPermissionDeps(openDatabase(file), dataDir));
    const text = readFileSync(join(dataDir, PERMISSION_AUDIT_FILE), 'utf8');
    const [line] = readJsonLines(join(dataDir, PERMISSION_AUDIT_FILE));
    assert.equal(line?.event, 'closed');
    assert.equal(line?.state, 'core_restarted');
    assert.equal(line?.settledBy, 'core_restart');
    assert.doesNotMatch(text, /hunter2pw|plain words|npm run migrate/);
  });
});

describe('the system adapters of the deps', () => {
  test('the clock tells the time and its timer fires, or is cancelled, without waiting for real', async () => {
    const deps = openPermissionDeps(openDatabase(join(tempDir(), 'core.sqlite')), tempDir());
    assert.ok(Math.abs(deps.clock.now() - Date.now()) < 2_000);
    const fired = deps.clock.timer(1);
    await fired.elapsed;
    const cancelled = deps.clock.timer(60_000);
    cancelled.cancel();
  });

  test('the notifier tells a listener of that request once and stops when asked; ids are never reused', () => {
    const deps = openPermissionDeps(openDatabase(join(tempDir(), 'core.sqlite')), tempDir());
    const heard: string[] = [];
    const stop = deps.notifier.subscribe('rq-1', () => heard.push('rq-1'));
    deps.notifier.subscribe('rq-2', () => heard.push('rq-2'));
    deps.notifier.publish({ sessionId: 'S1', requestId: 'rq-1', state: 'answered' });
    stop();
    deps.notifier.publish({ sessionId: 'S1', requestId: 'rq-1', state: 'delivered' });
    assert.deepEqual(heard, ['rq-1']);
    assert.notEqual(deps.newId(), deps.newId());
  });
});
