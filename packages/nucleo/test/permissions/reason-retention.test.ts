// A deny reason is clear in SQLite while the request is open and for the window the /ui list shows, then it is gone (#618/AC-7, layer 3).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openPermissionDeps } from '../../src/permissions/adapters/deps.ts';
import { SqlitePermissionRepository } from '../../src/permissions/adapters/sqlite-repository.ts';
import { expireDue, sweepOnStart } from '../../src/permissions/expire-due.ts';
import { listRequests, RECENT_MS } from '../../src/permissions/list-requests.ts';
import type { PermissionRequest } from '../../src/permissions/model.ts';
import { answerWith, openDatabase, openRequest, tempDir } from './oltp-fixtures.ts';

const rawReason = (db: DatabaseSync, id: string): unknown => db.prepare('SELECT reason FROM permission_requests WHERE id = ?').get(id)?.reason;
const MINUTE = 60_000;

/** A deny with a reason, delivered `minutesAgo` minutes ago, saved through the repository. (#618) */
async function deliveredDeny(repository: SqlitePermissionRepository, id: string, minutesAgo: number): Promise<PermissionRequest> {
  const at = Date.now() - minutesAgo * MINUTE;
  const request = answerWith(await openRequest({ id, now: at - 1_000 }), 'deny', `reason of ${id}`, at - 500);
  request.deliver(at);
  repository.save(request);
  return request;
}

describe('the deny reason does not outlive the /ui window (#618/AC-7)', () => {
  test('#618/AC-7: listing a session nulls the reason of a request settled before the window, and keeps the others as they were', async () => {
    const dataDir = tempDir();
    const db = openDatabase(join(dataDir, 'core.sqlite'));
    const deps = openPermissionDeps(db, dataDir);
    const repository = new SqlitePermissionRepository(db);
    await deliveredDeny(repository, 'old', 11);
    await deliveredDeny(repository, 'recent', 9);
    repository.save(answerWith(await openRequest({ id: 'answered', now: Date.now() }), 'deny', 'reason of answered'));
    repository.save(await openRequest({ id: 'pending', now: Date.now() }));

    const listing = listRequests(deps, { sessionId: 'S1', unavailableReason: null });

    assert.equal(rawReason(db, 'old'), null);
    assert.equal(rawReason(db, 'recent'), 'reason of recent');
    assert.equal(rawReason(db, 'answered'), 'reason of answered');
    assert.deepEqual(listing.requests.map((r) => [r.id, r.reason]).sort(), [['answered', 'reason of answered'], ['pending', null], ['recent', 'reason of recent']]);
  });

  test('a request the person still sees keeps its reason on the screen until the window closes, then none is left in the row', async () => {
    const dataDir = tempDir();
    const db = openDatabase(join(dataDir, 'core.sqlite'));
    const deps = openPermissionDeps(db, dataDir);
    const repository = new SqlitePermissionRepository(db);
    await deliveredDeny(repository, 'edge', RECENT_MS / MINUTE - 1);
    assert.equal(listRequests(deps, { sessionId: 'S1', unavailableReason: null }).requests[0]?.reason, 'reason of edge');
    assert.equal(rawReason(db, 'edge'), 'reason of edge');
  });

  test('the start sweep nulls the reasons of requests settled before the window, in every session', async () => {
    const dataDir = tempDir();
    const file = join(dataDir, 'core.sqlite');
    const before = new SqlitePermissionRepository(openDatabase(file));
    await deliveredDeny(before, 'old', 30);
    const other = answerWith(await openRequest({ id: 'other-old', sessionId: 'S2', now: Date.now() - 40 * MINUTE }), 'deny', 'reason of other-old', Date.now() - 39 * MINUTE);
    other.withdraw(Date.now() - 38 * MINUTE);
    before.save(other);
    await deliveredDeny(before, 'recent', 2);

    const db = openDatabase(file);
    sweepOnStart(openPermissionDeps(db, dataDir));

    assert.equal(rawReason(db, 'old'), null);
    assert.equal(rawReason(db, 'other-old'), null);
    assert.equal(rawReason(db, 'recent'), 'reason of recent');
  });

  test('a request swept as core_restarted keeps its reason inside the window', async () => {
    const dataDir = tempDir();
    const file = join(dataDir, 'core.sqlite');
    new SqlitePermissionRepository(openDatabase(file)).save(answerWith(await openRequest({ id: 'answered', now: Date.now() }), 'deny', 'reason of answered'));
    const db = openDatabase(file);
    sweepOnStart(openPermissionDeps(db, dataDir));
    assert.equal(rawReason(db, 'answered'), 'reason of answered');
  });

  test('the decision and every other column of a request whose reason was nulled are kept', async () => {
    const dataDir = tempDir();
    const db = openDatabase(join(dataDir, 'core.sqlite'));
    const repository = new SqlitePermissionRepository(db);
    const old = await deliveredDeny(repository, 'old', 11);
    listRequests(openPermissionDeps(db, dataDir), { sessionId: 'S1', unavailableReason: null });
    const read = repository.find('S1', 'old');
    assert.equal(read?.decision, 'deny');
    assert.equal(read?.reason, null);
    assert.equal(read?.settledAt, old.settledAt);
    assert.equal(read?.digest, old.digest);
  });

  test('the expiry sweep nulls the reasons settled before the window, with no listing and no restart', async () => {
    const dataDir = tempDir();
    const db = openDatabase(join(dataDir, 'core.sqlite'));
    const deps = openPermissionDeps(db, dataDir);
    const repository = new SqlitePermissionRepository(db);
    await deliveredDeny(repository, 'old', 11);
    await deliveredDeny(repository, 'recent', 9);

    expireDue(deps);

    assert.equal(rawReason(db, 'old'), null);
    assert.equal(rawReason(db, 'recent'), 'reason of recent');
  });
});
