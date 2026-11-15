// The SQLite adapter of the permission requests against a real database with the migrations applied (#618, layer 3).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { join } from 'node:path';
import { schemaVersion } from '../../src/adapters/sqlite/migrations.ts';
import { SqlitePermissionRepository } from '../../src/permissions/adapters/sqlite-repository.ts';
import { CHANNELS, DECISIONS, PermissionRefusal, PermissionRequest, REQUEST_STATES, SETTLERS } from '../../src/permissions/model.ts';
import { waitForDecision } from '../../src/permissions/wait-for-decision.ts';
import { answerRequest } from '../../src/permissions/answer-request.ts';
import { registerRequest } from '../../src/permissions/register-request.ts';
import { harness, registerInput, T0 } from './fakes.ts';
import { answerWith, openDatabase, openRequest, requestsInEveryState, SECRET_COMMAND, snapshot, tempDir } from './oltp-fixtures.ts';

const refusedWith = (code: string) => (e: unknown) => e instanceof PermissionRefusal && e.code === code;
const twoConnections = () => {
  const file = join(tempDir(), 'core.sqlite');
  const dbA = openDatabase(file);
  const dbB = openDatabase(file);
  return { dbA, dbB, a: new SqlitePermissionRepository(dbA), b: new SqlitePermissionRepository(dbB) };
};

describe('the permission_requests table', () => {
  test('the migration creates it with the indexes by session and by state', () => {
    const db = openDatabase(join(tempDir(), 'core.sqlite'));
    assert.ok(schemaVersion(db) >= 21);
    const names = (type: string) => db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?').all(type, 'permission_requests').map((r) => r.name);
    assert.deepEqual(names('table'), ['permission_requests']);
    assert.ok(names('index').includes('permission_requests_by_session'));
    assert.ok(names('index').includes('permission_requests_by_state'));
  });

  test('#618/AC-7: it has a column for every aggregate field and the linked tool_use_id, and none for the raw tool input', () => {
    const db = openDatabase(join(tempDir(), 'core.sqlite'));
    const columns = db.prepare('PRAGMA table_info(permission_requests)').all().map((c) => c.name as string);
    for (const wanted of ['id', 'session_id', 'tool_name', 'digest', 'summary', 'summary_truncated', 'cwd', 'permission_mode', 'terminal_only', 'created_at', 'expires_at', 'state', 'decision', 'reason', 'answered_by', 'channel', 'answered_at', 'settled_at', 'settled_by', 'tool_use_id']) {
      assert.ok(columns.includes(wanted), `column ${wanted}`);
    }
    assert.deepEqual(columns.filter((c) => /input/.test(c)), []);
  });

  test('its constraints refuse a state, decision, channel or settler outside the model, and it is STRICT', () => {
    const db = openDatabase(join(tempDir(), 'core.sqlite'));
    const insert = (over: Record<string, string | number | null>) => {
      const row = { id: 'x', session_id: 'S', tool_name: 'Bash', digest: 'd', summary: 's', summary_truncated: 0, cwd: '/w', permission_mode: null, terminal_only: 0, created_at: 1, expires_at: 2, state: 'pending', decision: null, reason: null, answered_by: null, channel: null, answered_at: null, settled_at: null, settled_by: null, ...over };
      db.prepare(`INSERT INTO permission_requests (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    };
    insert({ id: 'ok' });
    assert.throws(() => insert({ id: 'a', state: 'delivering' }), /CHECK/);
    assert.throws(() => insert({ id: 'b', decision: 'maybe' }), /CHECK/);
    assert.throws(() => insert({ id: 'c', channel: 'cli' }), /CHECK/);
    assert.throws(() => insert({ id: 'd', settled_by: 'someone' }), /CHECK/);
    assert.throws(() => insert({ id: 'e', state: 'answered' }), /CHECK/);
    assert.throws(() => insert({ id: 'f', created_at: 'yesterday' }), /cannot store TEXT value in INTEGER column/);
    assert.throws(() => insert({ id: 'ok' }), /UNIQUE|PRIMARY/);
  });
});

describe('the lists of the migration and of the model', () => {
  test('every state, decision, channel and settler of the model is accepted by the table', () => {
    const db = openDatabase(join(tempDir(), 'core.sqlite'));
    let n = 0;
    const insert = (over: Record<string, string | number | null>) => {
      const row = { id: `r${++n}`, session_id: 'S', tool_name: 'Bash', digest: 'd', summary: 's', summary_truncated: 0, cwd: '/w', terminal_only: 0, created_at: 1, expires_at: 2, state: 'pending', decision: 'deny', ...over };
      db.prepare(`INSERT INTO permission_requests (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    };
    for (const state of REQUEST_STATES) insert({ state });
    for (const decision of DECISIONS) insert({ decision });
    for (const channel of CHANNELS) insert({ channel });
    for (const settled_by of SETTLERS) insert({ settled_by });
    assert.equal(n, REQUEST_STATES.length + DECISIONS.length + CHANNELS.length + SETTLERS.length);
  });
});

describe('the round trip', () => {
  test('a request in each state is read back with every field equal, answered_at and settled_at included', async () => {
    const { a, b } = twoConnections();
    const all = await requestsInEveryState();
    assert.deepEqual(all.map((r) => r.state).sort(), [...REQUEST_STATES].sort());
    for (const r of all) a.save(r);
    for (const r of all) {
      const back = b.find(r.sessionId, r.id);
      assert.ok(back instanceof PermissionRequest);
      assert.deepEqual(snapshot(back), snapshot(r), r.state);
      assert.equal(back.isOpen, r.isOpen);
    }
  });

  test('a truncated, terminal-only summary and a null permission mode survive', async () => {
    const { a, b } = twoConnections();
    const long = await openRequest({ id: 'long', toolInput: { command: `echo ${'x'.repeat(5_000)}` }, permissionMode: null });
    assert.equal(long.summaryTruncated, true);
    assert.equal(long.terminalOnly, true);
    a.save(long);
    const back = b.find('S1', 'long');
    assert.equal(back?.permissionMode, null);
    assert.equal(back?.summaryTruncated, true);
    assert.equal(back?.terminalOnly, true);
    assert.equal(back?.summary, long.summary);
    const plain = await openRequest({ id: 'plain', permissionMode: 'acceptEdits' });
    a.save(plain);
    assert.equal(b.find('S1', 'plain')?.permissionMode, 'acceptEdits');
    assert.equal(b.find('S1', 'plain')?.summaryTruncated, false);
    assert.equal(b.find('S1', 'plain')?.terminalOnly, false);
  });

  test('saving a request again updates the same row', async () => {
    const { a, b } = twoConnections();
    const r = await openRequest();
    a.save(r);
    answerWith(r);
    a.save(r);
    assert.equal(b.listBySession('S1').length, 1);
    assert.equal(b.find('S1', 'rq-1')?.state, 'answered');
    assert.equal(b.find('S1', 'rq-1')?.reason, 'not now');
  });

  test('the audit-relevant row holds the redacted summary and never the raw tool input (#618/AC-7)', async () => {
    const { a, dbA } = twoConnections();
    const r = await openRequest({ toolInput: { command: SECRET_COMMAND } });
    answerWith(r);
    a.save(r);
    const dump = JSON.stringify(dbA.prepare('SELECT * FROM permission_requests').all());
    assert.ok(dump.includes(JSON.stringify(r.summary).slice(1, -1)));
    assert.doesNotMatch(dump, /hunter2pw/);
    assert.doesNotMatch(dump, /postgres:\/\/u:/);
  });
});

describe('reading', () => {
  test('#618/AC-1: another session never finds the request, and an unknown id is null', async () => {
    const { a } = twoConnections();
    a.save(await openRequest({ sessionId: 'S1' }));
    assert.equal(a.find('S2', 'rq-1'), null);
    assert.equal(a.find('S1', 'missing'), null);
    assert.equal(a.find('S1', 'rq-1')?.id, 'rq-1');
  });

  test('listBySession is oldest first and holds only that session; listOpen holds only pending and answered, of every session', async () => {
    const { a } = twoConnections();
    const mk = (id: string, sessionId: string, now: number) => openRequest({ id, sessionId, now });
    const late = await mk('late', 'S1', T0 + 30);
    const early = await mk('early', 'S1', T0 + 10);
    const other = await mk('other', 'S2', T0 + 20);
    const closed = await mk('closed', 'S1', T0 + 5);
    closed.withdraw(T0 + 6);
    const answered = answerWith(await mk('answered', 'S2', T0 + 40));
    for (const r of [late, early, other, closed, answered]) a.save(r);
    assert.deepEqual(a.listBySession('S1').map((r) => r.id), ['closed', 'early', 'late']);
    assert.deepEqual(a.listBySession('S2').map((r) => r.id), ['other', 'answered']);
    assert.deepEqual(a.listBySession('S3'), []);
    assert.deepEqual(a.listOpen().map((r) => r.id), ['early', 'other', 'late', 'answered']);
  });

  test('a tool_use_id is linked once, read back, and kept when the request is saved again', async () => {
    const { a, b } = twoConnections();
    const r = await openRequest();
    a.save(r);
    assert.equal(b.toolUseOf('rq-1'), null);
    assert.equal(b.toolUseOf('missing'), null);
    a.linkToolUse('rq-1', 'toolu_01');
    assert.equal(b.toolUseOf('rq-1'), 'toolu_01');
    answerWith(r);
    a.save(r);
    assert.equal(b.toolUseOf('rq-1'), 'toolu_01');
  });
});

describe('the single delivery (#618/AC-2)', () => {
  test('#618/AC-2: two readers holding the same answered request: one delivery is saved, the other gets already_delivered', async () => {
    const { a, b, dbA } = twoConnections();
    const r = answerWith(await openRequest(), 'allow');
    a.save(r);
    const first = a.find('S1', 'rq-1')!;
    const second = b.find('S1', 'rq-1')!;
    first.deliver(T0 + 2_000);
    second.deliver(T0 + 3_000);
    a.save(first);
    assert.throws(() => b.save(second), refusedWith('already_delivered'));
    const row = dbA.prepare('SELECT state, settled_at, settled_by FROM permission_requests').get();
    assert.deepEqual({ ...row }, { state: 'delivered', settled_at: T0 + 2_000, settled_by: 'hook' });
  });

  test('#618/AC-2: the use case on two connections delivers the decision once and the second read is refused', async () => {
    const { a, b } = twoConnections();
    const first = { ...harness(), repository: a };
    const second = { ...harness(), repository: b };
    const registered = await registerRequest(first, await registerInput());
    answerRequest(first, { sessionId: 'S1', requestId: registered.requestId, decision: 'allow', answeredBy: 'owner', channel: 'ui' });
    const outcomes = await Promise.allSettled([
      waitForDecision(first, { sessionId: 'S1', requestId: registered.requestId, waitMs: 0 }),
      waitForDecision(second, { sessionId: 'S1', requestId: registered.requestId, waitMs: 0 }),
    ]);
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
    assert.ok(refusedWith('already_delivered')(rejected?.reason));
    assert.equal(a.find('S1', registered.requestId)?.state, 'delivered');
  });

  test('a stale pending copy cannot answer a request already answered: already_answered, the first answer stands', async () => {
    const { a, b } = twoConnections();
    a.save(await openRequest());
    const first = a.find('S1', 'rq-1')!;
    const stale = b.find('S1', 'rq-1')!;
    answerWith(first, 'deny', 'first');
    answerWith(stale, 'deny', 'second');
    a.save(first);
    assert.throws(() => b.save(stale), refusedWith('already_answered'));
    assert.equal(a.find('S1', 'rq-1')?.reason, 'first');
  });

  test('a stale answered copy cannot deliver a request that closed meanwhile: gone, and the closing stands', async () => {
    const { a, b } = twoConnections();
    a.save(answerWith(await openRequest()));
    const closing = a.find('S1', 'rq-1')!;
    const stale = b.find('S1', 'rq-1')!;
    closing.closeElsewhere(T0 + 2_000);
    a.save(closing);
    stale.deliver(T0 + 3_000);
    assert.throws(() => b.save(stale), refusedWith('gone'));
    assert.equal(a.find('S1', 'rq-1')?.state, 'answered_elsewhere');
  });
});
