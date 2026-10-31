import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, MIGRATIONS } from '../../src/adapters/sqlite/migrations.ts';
import { SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { SqliteRuntimeStore } from '../../src/runtime/sqlite.ts';
import { fixture } from './fixtures.ts';

for (const provider of ['claude', 'codex'] as const) test(`${provider}: durable scope, once-only responses and correlated events`, async () => {
  const f = await fixture(provider);
  try {
    const run = f.runs.createRun(f.scope, 1000);
    assert.throws(() => f.runs.createRun(f.scope, 1001), /UNIQUE/);
    f.runs.transition(f.scope, run.id, 'running', 1001);
    const approval = f.runs.request(f.scope, run.id, 'approval', 3000, 1002);
    const question = f.runs.request(f.scope, run.id, 'question', 3000, 1002);
    for (const wrong of [{ ...f.scope, provider: provider === 'claude' ? 'codex' : 'claude' },
      { ...f.scope, accountId: 'other' }, { ...f.scope, sessionId: 'other' }, { ...f.scope, profileId: 'other' }]) {
      assert.throws(() => f.runs.claimResponse(wrong as typeof f.scope, run.id, approval.id, { kind: 'approval', decision: 'approve' }, () => 1003));
    }
    assert.throws(() => f.runs.claimResponse(f.scope, 'another-run', approval.id, { kind: 'approval', decision: 'approve' }, () => 1003));
    assert.throws(() => f.runs.claimResponse(f.scope, run.id, question.id, { kind: 'approval', decision: 'approve' }, () => 1003));
    assert.throws(() => f.runs.claimResponse(f.scope, run.id, approval.id, { kind: 'approval', decision: 'approve' }, () => 3000));
    const attempts = await Promise.allSettled([1, 2].map(async () => f.runs.claimResponse(f.scope, run.id, approval.id, { kind: 'approval', decision: 'deny' }, () => 1004)));
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    f.runs.claimResponse(f.scope, run.id, question.id, { kind: 'question', answer: 'synthetic answer' }, () => 1004);
    const oldTurn = f.runs.request(f.scope, run.id, 'approval', 4000, 1005);
    assert.notEqual(f.runs.nextTurn(f.scope, run.id, 1005), run.turnId);
    assert.throws(() => f.runs.claimResponse(f.scope, run.id, oldTurn.id, { kind: 'approval', decision: 'approve' }, () => 1005));
    const pending = f.runs.request(f.scope, run.id, 'approval', 4000, 1005);
    f.runs.transition(f.scope, run.id, 'transport_error', 1006);
    assert.throws(() => f.runs.claimResponse(f.scope, run.id, pending.id, { kind: 'approval', decision: 'approve' }, () => 1007));
    const events = (await f.storage.listEvents(f.scope.sessionId)).items;
    assert.equal(events.filter(e => e.type === 'runtime.approval.claimed').length, 1);
    assert.equal(events.filter(e => e.type === 'runtime.question.claimed').length, 1);
    for (const event of events) {
      const data = event.data as Record<string, unknown>;
      assert.equal(data.provider, provider); assert.equal(data.accountId, f.scope.accountId);
      assert.equal(data.sessionId, f.scope.sessionId); assert.equal(data.runId, run.id);
      assert.ok(Object.hasOwn(data, 'requestId'));
      assert.ok(!JSON.stringify(data).includes('synthetic answer'));
    }
    const feed = await f.storage.listRecentEvents({ sessionId: f.scope.sessionId });
    assert.equal(feed.items.length, events.length);
    assert.ok(f.changes.current);
  } finally { await f.storage.close(); }
});

test('migration 15 preserves records and concurrent worker claims survive reopening', { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-'));
  const path = join(dir, 'db.sqlite');
  try {
    const db = new DatabaseSync(path);
    migrate(db, MIGRATIONS.filter(m => m.version < 15));
    db.prepare("INSERT INTO sessions (id,status,started_at,updated_at) VALUES ('legacy','active','2026-01-01','2026-01-01')").run();
    assert.deepEqual(migrate(db), [15]);
    assert.deepEqual(migrate(db), []);
    assert.equal(db.prepare("SELECT id FROM sessions WHERE id = 'legacy'").get()!.id, 'legacy');
    db.close();
    const f = await fixture('codex', path);
    const record = f.runs.createRun(f.scope, 1000);
    f.runs.transition(f.scope, record.id, 'running', 1001);
    const request = f.runs.request(f.scope, record.id, 'approval', 3000, 1002);
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const barrier = new Int32Array(shared);
    const workers: Worker[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const claims = await new Promise<{ status: string; code?: string }[]>((resolve, reject) => {
        const results: { status: string; code?: string }[] = [];
        let ready = 0;
        timer = setTimeout(() => reject(new Error('Concurrent claims timed out')), 30_000);
        for (let index = 0; index < 2; index++) {
          const worker = new Worker(new URL('./claim-worker.ts', import.meta.url), {
            workerData: { path, scope: f.scope, runId: record.id, requestId: request.id, shared },
          });
          workers.push(worker);
          let receivedResult = false;
          worker.on('message', message => {
            if (message.type === 'ready') {
              ready++;
              if (ready === 2) {
                // Release both blocked workers together, after both connections are ready.
                if (Atomics.load(barrier, 0) !== 2) return reject(new Error('Both claimants must reach the barrier'));
                Atomics.store(barrier, 1, 1);
                Atomics.notify(barrier, 1, 2);
              }
            } else if (message.type === 'result') {
              receivedResult = true;
              results.push({ status: message.status, ...(message.code ? { code: message.code } : {}) });
              if (results.length === 2) resolve(results);
            }
          });
          worker.once('error', reject);
          worker.once('exit', code => {
            if (code !== 0 || !receivedResult) reject(new Error(`Claim worker exited without success: ${code}`));
          });
        }
      });
      assert.equal(claims.filter(c => c.status === 'accepted').length, 1);
      assert.deepEqual(claims.filter(c => c.status === 'rejected'), [{ status: 'rejected', code: 'stale_request' }]);
      assert.equal(f.storage.db.prepare('SELECT state FROM runtime_requests WHERE id = ?').get(request.id)!.state, 'claimed');
    } finally {
      clearTimeout(timer);
      await Promise.all(workers.map(worker => worker.terminate()));
      await f.storage.close();
    }
    const reopened = new SqliteStorage({ path });
    try {
      const store = new SqliteRuntimeStore(reopened.db);
      assert.throws(() => store.claimResponse(f.scope, record.id, request.id, { kind: 'approval', decision: 'approve' }, () => 1004));
      assert.equal((await reopened.listEvents(f.scope.sessionId)).items.filter(e => e.type.endsWith('.claimed')).length, 1);
    } finally { await reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('event failure rolls back both state and request consumption', async () => {
  const f = await fixture();
  try {
    const run = f.runs.createRun(f.scope, 1000);
    f.runs.transition(f.scope, run.id, 'running', 1001);
    const request = f.runs.request(f.scope, run.id, 'approval', 3000, 1002);
    f.storage.db.exec("CREATE TRIGGER fail_runtime_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    assert.throws(() => f.runs.claimResponse(f.scope, run.id, request.id, { kind: 'approval', decision: 'approve' }, () => 1003));
    assert.equal(f.storage.db.prepare('SELECT state FROM runtime_requests WHERE id = ?').get(request.id)!.state, 'pending');
    assert.throws(() => f.runs.transition(f.scope, run.id, 'closed', 1003));
    assert.equal(f.runs.getRun(run.id)!.state, 'running');
  } finally { await f.storage.close(); }
});

test('approval expiring while waiting for a writer lock is rejected using post-lock time', { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-expiry-'));
  const path = join(dir, 'db.sqlite');
  const f = await fixture('claude', path);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let locked = false;
  try {
    const record = f.runs.createRun(f.scope, 1000);
    f.runs.transition(f.scope, record.id, 'running', 1001);
    const request = f.runs.request(f.scope, record.id, 'approval', 3000, 1002);
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const barrier = new Int32Array(shared);
    Atomics.store(barrier, 1, 1003);
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Expiry worker timed out')), 30_000);
      worker = new Worker(new URL('./expiry-worker.ts', import.meta.url), {
        workerData: { path, scope: f.scope, runId: record.id, requestId: request.id, shared },
      });
      let receivedResult = false;
      worker.on('message', message => {
        try {
          if (message.type === 'ready') {
            f.storage.db.exec('BEGIN IMMEDIATE');
            locked = true;
            Atomics.store(barrier, 0, 1);
            Atomics.notify(barrier, 0);
          } else if (message.type === 'waiting') {
            // The worker entered BEGIN while this connection owns the write lock.
            // A pre-lock clock read would already have incremented this counter.
            assert.equal(Atomics.load(barrier, 2), 0);
            Atomics.store(barrier, 1, 3000);
            f.storage.db.exec('COMMIT');
            locked = false;
          } else if (message.type === 'result') {
            receivedResult = true;
            assert.equal(message.code, 'stale_request');
            assert.equal(Atomics.load(barrier, 2), 1);
            resolve();
          }
        } catch (error) { reject(error); }
      });
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0 || !receivedResult) reject(new Error(`Expiry worker failed: ${code}`)); });
    });
    assert.equal(f.storage.db.prepare('SELECT state FROM runtime_requests WHERE id = ?').get(request.id)!.state, 'pending');
    assert.equal((await f.storage.listEvents(f.scope.sessionId)).items.filter(e => e.type.endsWith('.claimed')).length, 0);
  } finally {
    clearTimeout(timer);
    if (locked) f.storage.db.exec('ROLLBACK');
    await worker?.terminate();
    await f.storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart recovery does not overwrite a run closed after its initial snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-recovery-'));
  const path = join(dir, 'db.sqlite');
  const f = await fixture('claude', path);
  const second = new SqliteStorage({ path });
  try {
    const record = f.runs.createRun(f.scope, 1000);
    f.runs.transition(f.scope, record.id, 'running', 1001);
    const request = f.runs.request(f.scope, record.id, 'approval', 3000, 1002);
    const other = new SqliteRuntimeStore(second.db);
    const exec = f.storage.db.exec.bind(f.storage.db);
    let interleaved = false;
    f.storage.db.exec = (sql: string) => {
      // Deterministically place another connection's close after the SELECT but before BEGIN.
      if (sql === 'BEGIN IMMEDIATE' && !interleaved) {
        interleaved = true;
        other.transition(f.scope, record.id, 'closed', 1003);
      }
      return exec(sql);
    };
    const cursor = f.changes.current;
    assert.equal(f.runs.recoverDisconnected(1004), 0);
    assert.equal(f.changes.current, cursor);
    assert.equal(interleaved, true);
    assert.equal(f.runs.getRun(record.id)!.state, 'closed');
    assert.equal(f.storage.db.prepare('SELECT state FROM runtime_requests WHERE id = ?').get(request.id)!.state, 'invalidated');
    const events = (await f.storage.listEvents(f.scope.sessionId)).items;
    assert.equal(events.filter(e => e.type === 'runtime.closed').length, 1);
    assert.equal(events.filter(e => e.type === 'runtime.transport_error').length, 0);
  } finally {
    await second.close(); await f.storage.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown or empty scope never creates a managed run', async () => {
  const f = await fixture();
  try {
    for (const key of ['provider', 'profileId', 'accountId', 'sessionId']) {
      for (const value of [null, '', ' ']) {
        assert.throws(() => f.runs.createRun({ ...f.scope, [key]: value } as typeof f.scope), { code: 'scope_mismatch' });
      }
    }
    assert.equal(f.runs.listRuns(f.scope.sessionId).length, 0);
    assert.equal((await f.storage.listEvents(f.scope.sessionId)).items.length, 0);
  } finally { await f.storage.close(); }
});
